#!/usr/bin/env bash
# Despliega un ambiente completo en una sola ejecución (también uno que todavía no existe):
#   1. base (grupo de recursos, identidad, registro, Key Vault, Postgres, Redis, observabilidad)
#   2. secreto de JWT en Key Vault, si falta (se genera aquí y nunca pasa por el repo)
#   3. imagen en el registro (dev la construye; prod importa la misma que se probó en dev)
#   4. revisión nueva con 0 % del tráfico
#   5. prueba de humo contra la revisión nueva
#   6. promoción: la revisión nueva recibe el tráfico; la anterior se apaga (drena sus WebSocket)
#      y queda marcada como `previous` para el rollback
#
# Uso: infra/scripts/deploy.sh <dev|prod>
# Necesita: az con sesión iniciada, docker (solo dev), node 24, y las variables
# AZURE_LOCATION, DEPLOYER_PRINCIPAL_ID y ALERT_EMAIL.
set -euo pipefail

ENV_NAME="${1:?Uso: deploy.sh <dev|prod>}"
[[ "$ENV_NAME" == dev || "$ENV_NAME" == prod ]] || { echo "Ambiente inválido: $ENV_NAME" >&2; exit 2; }
: "${AZURE_LOCATION:?Falta AZURE_LOCATION}" "${DEPLOYER_PRINCIPAL_ID:?Falta DEPLOYER_PRINCIPAL_ID}" "${ALERT_EMAIL:?Falta ALERT_EMAIL}"
export AZURE_LOCATION DEPLOYER_PRINCIPAL_ID ALERT_EMAIL

# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"

SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
TAG="${SHA:0:12}"
# El sufijo de una revisión debe empezar con letra; el número de corrida evita choques al
# volver a desplegar el mismo commit.
SUFFIX="c${SHA:0:7}-${GITHUB_RUN_NUMBER:-$(date +%s)}"
RG="rg-arenal-$ENV_NAME"
APP="ca-arenal-$ENV_NAME"

deploy() {
  az deployment sub create \
    --name "arenal-$ENV_NAME-$1-$SUFFIX" \
    --location "$AZURE_LOCATION" \
    --parameters "$INFRA_DIR/$ENV_NAME.bicepparam" \
    --query properties.outputs -o json --only-show-errors
}

log "1/6 Base del ambiente $ENV_NAME"
if [[ "$(az group exists -n "$RG")" == false ]]; then
  echo "   el ambiente no existe: se crea desde cero"
  # Un Key Vault borrado queda retenido unos días con su nombre; se purga para poder recrearlo.
  purge_deleted_vaults "$ENV_NAME"
fi
export DEPLOY_APP=false
base="$(deploy base)"
ACR="$(jq -r .registryName.value <<<"$base")"
REGISTRY="$(jq -r .registryServer.value <<<"$base")"
VAULT="$(jq -r .vaultName.value <<<"$base")"

log "2/6 Secreto de firma de los JWT"
secret_exists() { az keyvault secret show --vault-name "$VAULT" --name jwt-private-key --query id -o tsv >/dev/null 2>&1; }
create_secret() {
  local key_file
  key_file="$(mktemp)"
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$key_file" 2>/dev/null
  az keyvault secret set --vault-name "$VAULT" --name jwt-private-key --file "$key_file" \
    --content-type application/x-pem-file --query id -o tsv --only-show-errors >/dev/null
  local status=$?
  rm -f "$key_file"
  return $status
}
if secret_exists; then
  echo "   ya existe; no se toca"
else
  retry 8 create_secret
  echo "   creado"
fi

log "3/6 Imagen arenal-server:$TAG"
if az acr repository show --name "$ACR" --image "arenal-server:$TAG" --only-show-errors >/dev/null 2>&1; then
  echo "   ya está en $ACR"
elif [[ "$ENV_NAME" == prod ]]; then
  # Producción usa exactamente la imagen que pasó por dev.
  source_id="$(az acr list -g rg-arenal-dev --query '[0].id' -o tsv)"
  [[ -n "$source_id" ]] || { echo "No hay registro de dev: despliega dev primero" >&2; exit 1; }
  retry 8 az acr import --name "$ACR" --registry "$source_id" \
    --source "arenal-server:$TAG" --image "arenal-server:$TAG" --only-show-errors
else
  retry 8 az acr login --name "$ACR" --only-show-errors
  docker build --build-arg "APP_VERSION=$TAG" -t "$REGISTRY/arenal-server:$TAG" "$INFRA_DIR/.."
  docker push "$REGISTRY/arenal-server:$TAG"
fi

log "4/6 Revisión nueva $APP--$SUFFIX"
STABLE="$(current_revision "$RG" "$APP")"
PREVIOUS="$(previous_revision "$RG" "$APP")"
# La anterior solo se conserva en el tráfico si sigue activa.
if [[ -n "$PREVIOUS" && "$(revision_active "$RG" "$APP" "$PREVIOUS")" != true ]]; then PREVIOUS=""; fi
export DEPLOY_APP=true IMAGE_TAG="$TAG" REVISION_SUFFIX="$SUFFIX"
export STABLE_REVISION_SUFFIX="${STABLE#"$APP--"}" PREVIOUS_REVISION_SUFFIX="${PREVIOUS#"$APP--"}"
echo "   tráfico actual: ${STABLE:-ninguna}; anterior: ${PREVIOUS:-ninguna}"
app="$(deploy app)"
NEXT_URL="$(jq -r .nextUrl.value <<<"$app")"
URL="$(jq -r .url.value <<<"$app")"
NEW="$(jq -r .newRevision.value <<<"$app")"

log "5/6 Prueba de humo en $NEXT_URL"
if ! node "$INFRA_DIR/scripts/smoke.mjs" "$NEXT_URL"; then
  echo "La revisión nueva no pasó la prueba: queda sin tráfico y se desactiva" >&2
  if [[ -n "$STABLE" ]]; then
    az containerapp revision deactivate -g "$RG" -n "$APP" --revision "$NEW" --only-show-errors || true
  fi
  exit 1
fi

log "6/6 Tráfico a la revisión nueva"
if [[ -n "$STABLE" && "$STABLE" != "$NEW" ]]; then
  export STABLE_REVISION_SUFFIX="$SUFFIX" PREVIOUS_REVISION_SUFFIX="${STABLE#"$APP--"}"
  deploy promote >/dev/null
  # Las conexiones nuevas ya van a la revisión nueva. Después de un rato se apagan las viejas:
  # el servidor cierra sus WebSocket con 1012 y los clientes reconectan a la nueva sin perder
  # la partida (el estado está en Postgres). La anterior queda marcada para el rollback.
  echo "   esperando ${DRAIN_SECONDS:-60} s antes de apagar las revisiones viejas"
  sleep "${DRAIN_SECONDS:-60}"
  mapfile -t old < <(az containerapp revision list -g "$RG" -n "$APP" \
    --query "[?properties.active && name!='$NEW'].name" -o tsv)
  for revision in "${old[@]}"; do
    echo "   desactivando $revision"
    az containerapp revision deactivate -g "$RG" -n "$APP" --revision "$revision" --only-show-errors
  done
fi

echo
echo "Listo: $URL ($NEW)"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  { echo "url=$URL"; echo "revision=$NEW"; } >>"$GITHUB_OUTPUT"
fi
