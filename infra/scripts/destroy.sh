#!/usr/bin/env bash
# Borra un ambiente completo para no gastar crédito (típicamente dev al terminar de probar).
# El siguiente despliegue lo vuelve a crear desde cero con infra/scripts/deploy.sh.
#
# Uso: infra/scripts/destroy.sh <dev|prod|shared> --yes
#   shared borra lo compartido (ambiente de Container Apps y Log Analytics); solo se puede
#   cuando ya no existen dev ni prod. Conviene dejarlo hasta el final: en las suscripciones de
#   estudiante, un ambiente de Container Apps recién borrado puede seguir contando para el
#   límite de uno por suscripción durante un tiempo.
set -euo pipefail

ENV_NAME="${1:?Uso: destroy.sh <dev|prod|shared> --yes}"
[[ "$ENV_NAME" == dev || "$ENV_NAME" == prod || "$ENV_NAME" == shared ]] || {
  echo "Ambiente inválido: $ENV_NAME" >&2
  exit 2
}
[[ "${2:-}" == --yes ]] || { echo "Esto borra rg-arenal-$ENV_NAME con todo lo que tiene. Confirma con --yes." >&2; exit 2; }
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"

if [[ "$ENV_NAME" == shared ]]; then
  for env in dev prod; do
    if [[ "$(az group exists -n "rg-arenal-$env")" == true ]]; then
      echo "Todavía existe rg-arenal-$env, que usa el ambiente compartido: bórralo primero." >&2
      exit 1
    fi
  done
fi

log "Borrando rg-arenal-$ENV_NAME (tarda unos minutos)"
az group delete -n "rg-arenal-$ENV_NAME" --yes --only-show-errors
if [[ "$ENV_NAME" != shared ]]; then purge_deleted_vaults "$ENV_NAME"; fi
echo "Listo: no queda nada de $ENV_NAME"
