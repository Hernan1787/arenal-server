#!/usr/bin/env bash
# Preparación única (la corre quien es dueño de la suscripción, por ejemplo en Azure Cloud Shell):
#   1. revisa que la región esté permitida (las suscripciones de estudiante limitan las regiones)
#   2. registra los proveedores de recursos que usa Arenal
#   3. crea la identidad del pipeline: una identidad administrada (rg-arenal-pipeline) sin
#      contraseña, con una credencial federada por environment de GitHub (OIDC)
#   4. le da permisos sobre la suscripción
#   5. crea los environments de GitHub (prod pide aprobación manual) y sus variables
#
# Uso: infra/scripts/bootstrap.sh <owner/repo> <región> <correo-de-alertas> [revisor-de-prod...]
# Ejemplo: infra/scripts/bootstrap.sh Hernan1787/arenal-server eastus2 equipo@ejemplo.com Hernan1787
#
# Es una identidad administrada y no un registro de aplicación en Entra ID porque crearla solo
# requiere permisos en la suscripción: muchos tenants universitarios no dejan registrar
# aplicaciones. No crea ninguna contraseña ni llave: en GitHub quedan IDs (tenant, suscripción,
# client ID) y el correo de alertas, que se guarda como secreto para que no aparezca en los logs.
set -euo pipefail

REPO="${1:?Uso: bootstrap.sh <owner/repo> <región> <correo> [revisores...]}"
LOCATION="${2:?Falta la región}"
ALERT_EMAIL="${3:?Falta el correo de alertas}"
shift 3
REVIEWERS=("$@")

PIPELINE_RG="rg-arenal-pipeline"
PIPELINE_IDENTITY="id-arenal-github"

command -v gh >/dev/null || { echo "Falta GitHub CLI (gh). En Cloud Shell ya viene instalado." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || gh auth login --hostname github.com --git-protocol https --web

SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
TENANT_ID="$(az account show --query tenantId -o tsv)"
echo "Suscripción: $(az account show --query name -o tsv) ($SUBSCRIPTION_ID)"

echo "==> Región"
# Azure for Students asigna una política con las regiones permitidas (cambian por persona). Según
# la definición, el parámetro se llama listOfAllowedLocations o allowedLocations.
mapfile -t allowed < <(
  for param in listOfAllowedLocations allowedLocations; do
    az policy assignment list --disable-scope-strict-match \
      --query "[].parameters.$param.value[]" -o tsv 2>/dev/null || true
  done | tr '[:upper:]' '[:lower:]' | sort -u
)
if ((${#allowed[@]} > 0)); then
  echo "   regiones permitidas por la suscripción: ${allowed[*]}"
  if [[ ! " ${allowed[*]} " == *" ${LOCATION,,} "* ]]; then
    echo "La región $LOCATION no está permitida. Escoge una de: ${allowed[*]}" >&2
    exit 1
  fi
else
  echo "   no se encontró una política de regiones permitidas"
fi
# Solo se puede crear un ambiente de Container Apps por suscripción de estudiante: si ya hay otro
# que no es el de Arenal, el primer despliegue fallaría.
others="$(az resource list --resource-type Microsoft.App/managedEnvironments \
  --query "[?name!='cae-arenal'].[name, resourceGroup]" -o tsv)"
if [[ -n "$others" ]]; then
  echo "   aviso: ya hay otros ambientes de Container Apps en la suscripción:"
  while IFS= read -r line; do echo "     $line"; done <<<"$others"
  echo "   Si la suscripción permite uno solo, bórralos antes del primer despliegue."
fi

echo "==> Proveedores de recursos"
for ns in Microsoft.App Microsoft.ContainerRegistry Microsoft.KeyVault Microsoft.DBforPostgreSQL \
  Microsoft.Cache Microsoft.OperationalInsights Microsoft.Insights Microsoft.ManagedIdentity \
  Microsoft.Consumption Microsoft.PolicyInsights; do
  az provider register --namespace "$ns" --only-show-errors >/dev/null
done

echo "==> Identidad del pipeline ($PIPELINE_RG/$PIPELINE_IDENTITY)"
az group create -n "$PIPELINE_RG" -l "$LOCATION" \
  --tags proyecto=arenal ambiente=pipeline curso=diseno-de-software-tec --only-show-errors >/dev/null
az identity create -g "$PIPELINE_RG" -n "$PIPELINE_IDENTITY" -l "$LOCATION" --only-show-errors >/dev/null
CLIENT_ID="$(az identity show -g "$PIPELINE_RG" -n "$PIPELINE_IDENTITY" --query clientId -o tsv)"
PRINCIPAL_ID="$(az identity show -g "$PIPELINE_RG" -n "$PIPELINE_IDENTITY" --query principalId -o tsv)"

# Credenciales federadas por environment: solo los jobs de esos environments de este repo entran.
# GitHub identifica el repo en el token de dos formas según la configuración de la cuenta: con
# nombres (repo:dueño/repo:…) o con nombres e IDs inmutables (repo:dueño@123/repo@456:…). Se
# registran las dos para que el login funcione con cualquiera.
read -r OWNER_ID REPO_ID < <(gh api "repos/$REPO" --jq '"\(.owner.id) \(.id)"')
OWNER="${REPO%%/*}"
NAME="${REPO#*/}"
federate() {
  local name=$1 subject=$2
  if ! az identity federated-credential show -g "$PIPELINE_RG" --identity-name "$PIPELINE_IDENTITY" \
    -n "$name" --only-show-errors >/dev/null 2>&1; then
    az identity federated-credential create -g "$PIPELINE_RG" --identity-name "$PIPELINE_IDENTITY" \
      -n "$name" \
      --issuer https://token.actions.githubusercontent.com \
      --subject "$subject" \
      --audiences api://AzureADTokenExchange --only-show-errors >/dev/null
  fi
}
for env in dev prod; do
  federate "github-$env" "repo:$REPO:environment:$env"
  federate "github-$env-ids" "repo:$OWNER@$OWNER_ID/$NAME@$REPO_ID:environment:$env"
done

echo "==> Permisos en la suscripción"
# Contributor crea los recursos; RBAC Administrator, las asignaciones de rol de la plantilla
# (la identidad de la app sobre el registro, Key Vault y App Insights). Una identidad recién
# creada tarda en aparecer en Entra ID: se reintenta.
assign() {
  local role=$1 i
  if [[ -n "$(az role assignment list --scope "/subscriptions/$SUBSCRIPTION_ID" --role "$role" \
    --query "[?principalId=='$PRINCIPAL_ID'].id" -o tsv)" ]]; then
    return 0
  fi
  for i in 1 2 3 4 5 6; do
    if az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
      --role "$role" --scope "/subscriptions/$SUBSCRIPTION_ID" --only-show-errors >/dev/null; then
      return 0
    fi
    echo "   todavía no se puede asignar «$role» (intento $i); se reintenta en 15 s" >&2
    sleep 15
  done
  return 1
}
assign "Contributor"
assign "Role Based Access Control Administrator"

echo "==> Environments y variables de GitHub"
reviewers_json="[]"
if ((${#REVIEWERS[@]} > 0)); then
  reviewers_json="$(for login in "${REVIEWERS[@]}"; do
    gh api "users/$login" --jq '{type: "User", id: .id}'
  done | jq -s .)"
fi
gh api -X PUT "repos/$REPO/environments/dev" >/dev/null
jq -n --argjson reviewers "$reviewers_json" '{reviewers: $reviewers, prevent_self_review: false}' |
  gh api -X PUT "repos/$REPO/environments/prod" --input - >/dev/null

set_var() { gh variable set "$1" --repo "$REPO" --body "$2"; }
set_var AZURE_CLIENT_ID "$CLIENT_ID"
set_var AZURE_TENANT_ID "$TENANT_ID"
set_var AZURE_SUBSCRIPTION_ID "$SUBSCRIPTION_ID"
set_var AZURE_LOCATION "${LOCATION,,}"
set_var DEPLOYER_PRINCIPAL_ID "$PRINCIPAL_ID"
# El correo es un dato personal y el repo es público: va como secreto para que no salga en los logs.
gh secret set ALERT_EMAIL --repo "$REPO" --body "$ALERT_EMAIL"

echo
echo "Listo. Actions > Despliegue > Run workflow (o el próximo push a main) crea dev desde cero."
echo "Producción espera la aprobación de: ${REVIEWERS[*]:-nadie (agrega revisores en Settings > Environments > prod)}"
