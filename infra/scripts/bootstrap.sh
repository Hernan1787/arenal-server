#!/usr/bin/env bash
# Preparación única (la corre quien es dueño de la suscripción, por ejemplo en Azure Cloud Shell):
#   1. registra los proveedores de recursos que usa Arenal
#   2. crea la identidad del pipeline en Entra ID, sin contraseña: GitHub entra con OIDC
#   3. le da permisos sobre la suscripción
#   4. crea los environments de GitHub (prod pide aprobación manual) y sus variables
#
# Uso: infra/scripts/bootstrap.sh <owner/repo> <región> <correo-de-alertas> [revisor-de-prod...]
# Ejemplo: infra/scripts/bootstrap.sh Hernan1787/arenal-server eastus2 equipo@ejemplo.com Hernan1787
#
# No crea ninguna contraseña ni llave: en GitHub quedan IDs (tenant, suscripción, client ID) y el
# correo de alertas, que se guarda como secreto solo para que no aparezca en los logs públicos.
set -euo pipefail

REPO="${1:?Uso: bootstrap.sh <owner/repo> <región> <correo> [revisores...]}"
LOCATION="${2:?Falta la región}"
ALERT_EMAIL="${3:?Falta el correo de alertas}"
shift 3
REVIEWERS=("$@")

command -v gh >/dev/null || { echo "Falta GitHub CLI (gh). En Cloud Shell ya viene instalado." >&2; exit 1; }
gh auth status >/dev/null 2>&1 || gh auth login

SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
TENANT_ID="$(az account show --query tenantId -o tsv)"
echo "Suscripción: $(az account show --query name -o tsv) ($SUBSCRIPTION_ID)"

echo "==> Proveedores de recursos"
for ns in Microsoft.App Microsoft.ContainerRegistry Microsoft.KeyVault Microsoft.DBforPostgreSQL \
  Microsoft.Cache Microsoft.OperationalInsights Microsoft.Insights Microsoft.ManagedIdentity \
  Microsoft.Consumption; do
  az provider register --namespace "$ns" --only-show-errors >/dev/null
done

echo "==> Identidad del pipeline"
APP_NAME="arenal-github-deployer"
CLIENT_ID="$(az ad app list --display-name "$APP_NAME" --query '[0].appId' -o tsv)"
if [[ -z "$CLIENT_ID" ]]; then
  CLIENT_ID="$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)"
fi
PRINCIPAL_ID="$(az ad sp list --filter "appId eq '$CLIENT_ID'" --query '[0].id' -o tsv)"
if [[ -z "$PRINCIPAL_ID" ]]; then
  PRINCIPAL_ID="$(az ad sp create --id "$CLIENT_ID" --query id -o tsv)"
fi

# Una credencial federada por environment: solo los jobs de esos environments pueden entrar.
for env in dev prod; do
  name="github-$env"
  if [[ -z "$(az ad app federated-credential list --id "$CLIENT_ID" --query "[?name=='$name'].name" -o tsv)" ]]; then
    az ad app federated-credential create --id "$CLIENT_ID" --parameters "{
      \"name\": \"$name\",
      \"issuer\": \"https://token.actions.githubusercontent.com\",
      \"subject\": \"repo:$REPO:environment:$env\",
      \"audiences\": [\"api://AzureADTokenExchange\"]
    }" --only-show-errors >/dev/null
  fi
done

echo "==> Permisos en la suscripción"
# Contributor crea los recursos; RBAC Administrator, las asignaciones de rol de la plantilla
# (la identidad de la app sobre el registro, Key Vault y App Insights).
for role in "Contributor" "Role Based Access Control Administrator"; do
  az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
    --role "$role" --scope "/subscriptions/$SUBSCRIPTION_ID" --only-show-errors >/dev/null
done

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
set_var AZURE_LOCATION "$LOCATION"
set_var DEPLOYER_PRINCIPAL_ID "$PRINCIPAL_ID"
# El correo es un dato personal y el repo es público: va como secreto para que no salga en los logs.
gh secret set ALERT_EMAIL --repo "$REPO" --body "$ALERT_EMAIL"

echo
echo "Listo. El próximo push a main (o Actions > Despliegue > Run workflow) crea dev desde cero."
echo "Producción espera la aprobación de: ${REVIEWERS[*]:-nadie (agrega revisores en Settings > Environments > prod)}"
