# Funciones compartidas por los scripts de despliegue. Se carga con `source`.
# shellcheck shell=bash

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export INFRA_DIR

# Las extensiones de az (containerapp) se instalan solas, sin preguntar.
az config set extension.use_dynamic_install=yes_without_prompt --only-show-errors >/dev/null

log() { printf '\n==> %s\n' "$*"; }

# Reintenta un comando: los permisos recién asignados en Azure tardan unos minutos en aplicar.
retry() {
  local attempts=$1
  shift
  local i
  for ((i = 1; i <= attempts; i++)); do
    if "$@"; then return 0; fi
    if ((i < attempts)); then
      echo "   falló (intento $i de $attempts); se reintenta en 15 s" >&2
      sleep 15
    fi
  done
  return 1
}

# Revisión que recibe el 100 % del tráfico y la marcada como anterior (para rollback).
current_revision() {
  az containerapp ingress traffic show -g "$1" -n "$2" \
    --query "[?weight==\`100\`].revisionName | [0]" -o tsv 2>/dev/null || true
}
previous_revision() {
  az containerapp ingress traffic show -g "$1" -n "$2" \
    --query "[?label=='previous'].revisionName | [0]" -o tsv 2>/dev/null || true
}

revision_active() {
  az containerapp revision show -g "$1" -n "$2" --revision "$3" --query properties.active -o tsv 2>/dev/null || true
}

# Purga los Key Vault borrados de un ambiente (quedan retenidos 7 días con su nombre).
purge_deleted_vaults() {
  local vault
  for vault in $(az keyvault list-deleted --resource-type vault --query "[?starts_with(name, 'kv-arenal-$1-')].name" -o tsv); do
    echo "   purgando el Key Vault borrado $vault"
    az keyvault purge --name "$vault" --only-show-errors
  done
}
