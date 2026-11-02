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

# Etiqueta de la imagen que corre hoy la app (vacío si la app no existe).
app_image_tag() {
  local image
  image="$(az containerapp show -g "$1" -n "$2" --query "properties.template.containers[0].image" -o tsv 2>/dev/null || true)"
  [[ -n "$image" ]] && echo "${image##*:}"
  return 0
}

# Purga los Key Vault borrados de un ambiente (quedan retenidos 7 días con su nombre).
purge_deleted_vaults() {
  local vault
  for vault in $(az keyvault list-deleted --resource-type vault --query "[?starts_with(name, 'kv-arenal-$1-')].name" -o tsv); do
    echo "   purgando el Key Vault borrado $vault"
    az keyvault purge --name "$vault" --only-show-errors
  done
}
