#!/usr/bin/env bash
# Borra un ambiente completo para no gastar crédito (típicamente dev al terminar de probar).
# El siguiente despliegue lo vuelve a crear desde cero con infra/scripts/deploy.sh.
#
# Uso: infra/scripts/destroy.sh <dev|prod> --yes
set -euo pipefail

ENV_NAME="${1:?Uso: destroy.sh <dev|prod> --yes}"
[[ "${2:-}" == --yes ]] || { echo "Esto borra rg-arenal-$ENV_NAME con su base de datos. Confirma con --yes." >&2; exit 2; }
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"

log "Borrando rg-arenal-$ENV_NAME (tarda unos minutos)"
az group delete -n "rg-arenal-$ENV_NAME" --yes --only-show-errors
purge_deleted_vaults "$ENV_NAME"
echo "Listo: no queda nada de $ENV_NAME"
