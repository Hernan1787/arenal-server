#!/usr/bin/env bash
# Rollback: reactiva la revisión anterior (la imagen sigue en el registro), le devuelve el 100 %
# del tráfico y la prueba. Tarda un par de minutos. No toca la base de datos: las migraciones son
# compatibles hacia atrás. Ver docs/deploy.md.
#
# Uso: infra/scripts/rollback.sh <dev|prod> [revisión]
set -euo pipefail

ENV_NAME="${1:?Uso: rollback.sh <dev|prod> [revisión]}"
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"

RG="rg-arenal-$ENV_NAME"
APP="ca-arenal-$ENV_NAME"
started=$SECONDS

CURRENT="$(current_revision "$RG" "$APP")"
TARGET="${2:-$(previous_revision "$RG" "$APP")}"
[[ -n "$TARGET" ]] || { echo "No hay revisión anterior marcada; pasa una: rollback.sh $ENV_NAME <revisión>" >&2; exit 1; }
[[ "$TARGET" != "$CURRENT" ]] || { echo "$TARGET ya recibe el tráfico" >&2; exit 1; }

log "Rollback de $APP: $CURRENT -> $TARGET"
if [[ "$(revision_active "$RG" "$APP" "$TARGET")" != true ]]; then
  echo "   la revisión estaba inactiva; se activa"
  az containerapp revision activate -g "$RG" -n "$APP" --revision "$TARGET" --only-show-errors
fi

# Espera a que la revisión tenga réplicas sanas antes de mandarle jugadores.
for _ in $(seq 1 40); do
  [[ "$(az containerapp revision show -g "$RG" -n "$APP" --revision "$TARGET" --query properties.healthState -o tsv)" == Healthy ]] && break
  sleep 5
done

az containerapp ingress traffic set -g "$RG" -n "$APP" \
  --revision-weight "$TARGET=100" "$CURRENT=0" --only-show-errors -o none

url="https://$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)"
node "$INFRA_DIR/scripts/smoke.mjs" "$url"
echo
echo "Rollback listo en $((SECONDS - started)) s: $url sirve $TARGET"
