#!/usr/bin/env bash
# Despliega un ambiente completo en una sola ejecución (también uno que todavía no existe):
#   1. base (grupo de recursos, identidad, registro, Key Vault, Postgres, Redis, observabilidad)
#   2. secreto de JWT en Key Vault, si falta (se genera aquí y nunca pasa por el repo)
#   3. imagen en el registro (dev la construye; prod importa la misma que se probó en dev)
#   4. revisión nueva: Container Apps la arranca, le pasa el tráfico cuando está sana y apaga la
#      anterior, que drena sus WebSocket (los clientes reconectan). El ambiente es Express: una
#      sola revisión activa, sin tráfico dividido (ADR 0011)
#   5. prueba de humo contra la URL pública, esperando a que responda la versión nueva. Si falla,
#      se vuelve a la imagen anterior (rollback automático)
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
# Versión que muestra /health/live: el commit y el número de corrida (cambia en cada despliegue,
# así que siempre hay revisión nueva aunque se vuelva a desplegar el mismo commit).
VERSION="c${SHA:0:7}-${GITHUB_RUN_NUMBER:-$(date +%s)}"
RG="rg-arenal-$ENV_NAME"
APP="ca-arenal-$ENV_NAME"

deploy() {
  az deployment sub create \
    --name "arenal-$ENV_NAME-$1-$VERSION" \
    --location "$AZURE_LOCATION" \
    --parameters "$INFRA_DIR/$ENV_NAME.bicepparam" \
    --query properties.outputs -o json --only-show-errors
}

log "1/5 Base del ambiente $ENV_NAME"
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

log "2/5 Secreto de firma de los JWT"
refresh_login
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

log "3/5 Imagen arenal-server:$TAG"
refresh_login
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

log "4/5 Revisión nueva de $APP ($VERSION)"
refresh_login
PREVIOUS_TAG="$(app_image_tag "$RG" "$APP")"
echo "   imagen actual: ${PREVIOUS_TAG:-ninguna (primer despliegue)}"
export DEPLOY_APP=true IMAGE_TAG="$TAG" APP_VERSION="$VERSION" PREVIOUS_IMAGE_TAG="$PREVIOUS_TAG"
app="$(deploy app)"
URL="$(jq -r .url.value <<<"$app")"
REVISION="$(jq -r .latestRevision.value <<<"$app")"

log "5/5 Prueba de humo en $URL"
if ! node "$INFRA_DIR/scripts/smoke.mjs" "$URL" "$VERSION"; then
  if [[ -n "$PREVIOUS_TAG" && "$PREVIOUS_TAG" != "$TAG" ]]; then
    echo "La versión nueva no pasó la prueba: se vuelve a la imagen $PREVIOUS_TAG" >&2
    "$INFRA_DIR/scripts/rollback.sh" "$ENV_NAME" "$PREVIOUS_TAG" || true
  fi
  exit 1
fi

echo
echo "Listo: $URL ($REVISION, imagen $TAG)"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  { echo "url=$URL"; echo "revision=$REVISION"; } >>"$GITHUB_OUTPUT"
fi
