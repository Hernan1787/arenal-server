#!/usr/bin/env bash
# Rollback: vuelve a poner la imagen anterior (sigue en el registro). Container Apps crea una
# revisión con esa imagen, le pasa el tráfico cuando está sana y apaga la actual; los clientes
# reconectan sin perder la partida. No toca la base de datos: las migraciones son compatibles
# hacia atrás. Tarda un par de minutos. Ver docs/deploy.md.
#
# Uso: infra/scripts/rollback.sh <dev|prod> [etiqueta-de-imagen]
#   Sin etiqueta, usa la anterior al último despliegue (la etiqueta `imagenAnterior` de la app).
set -euo pipefail

ENV_NAME="${1:?Uso: rollback.sh <dev|prod> [etiqueta-de-imagen]}"
[[ "$ENV_NAME" == dev || "$ENV_NAME" == prod ]] || { echo "Ambiente inválido: $ENV_NAME" >&2; exit 2; }
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"

RG="rg-arenal-$ENV_NAME"
APP="ca-arenal-$ENV_NAME"
started=$SECONDS

current_image="$(az containerapp show -g "$RG" -n "$APP" --query "properties.template.containers[0].image" -o tsv)"
registry="${current_image%%/*}"
current_tag="${current_image##*:}"
target_tag="${2:-}"
if [[ -z "$target_tag" ]]; then
  previous_image="$(az containerapp show -g "$RG" -n "$APP" --query "tags.imagenAnterior" -o tsv)"
  target_tag="${previous_image##*:}"
fi
[[ -n "$target_tag" ]] || { echo "No hay imagen anterior anotada; pasa una: rollback.sh $ENV_NAME <etiqueta>" >&2; exit 1; }
[[ "$target_tag" != "$current_tag" ]] || { echo "$APP ya corre la imagen $target_tag" >&2; exit 1; }

VERSION="rollback-${target_tag:0:7}-$(date +%s)"
log "Rollback de $APP: $current_tag -> $target_tag"
# Las etiquetas quedan al revés: si hay que deshacer el rollback, la anterior es la que se quitó.
az containerapp update -g "$RG" -n "$APP" --image "$registry/arenal-server:$target_tag" \
  --set-env-vars "APP_VERSION=$VERSION" \
  --tags proyecto=arenal "ambiente=$ENV_NAME" curso=diseno-de-software-tec \
  "imagen=$registry/arenal-server:$target_tag" "imagenAnterior=$current_image" \
  --only-show-errors -o none

url="https://$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)"
node "$INFRA_DIR/scripts/smoke.mjs" "$url" "$VERSION"
echo
echo "Rollback listo en $((SECONDS - started)) s: $url corre la imagen $target_tag"
