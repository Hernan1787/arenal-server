// Ambiente de desarrollo: se despliega solo en cada push a main. Escala a cero cuando nadie
// lo usa; conviene borrarlo (az group delete -n rg-arenal-dev) cuando no se esté probando.
using 'main.bicep'

param environmentName = 'dev'
param location = readEnvironmentVariable('AZURE_LOCATION', 'eastus2')
param deployerPrincipalId = readEnvironmentVariable('DEPLOYER_PRINCIPAL_ID', '')
param alertEmail = readEnvironmentVariable('ALERT_EMAIL', '')
param monthlyBudget = 35
param budgetStartDate = '2026-11-01'
param minReplicas = 0
param maxReplicas = 2
// La prueba de carga crea cientos de usuarios desde una sola IP (ver docs/load-test.md).
// Producción conserva los límites normales.
param relaxedRateLimits = true
param deployApp = bool(readEnvironmentVariable('DEPLOY_APP', 'false'))
param imageTag = readEnvironmentVariable('IMAGE_TAG', '')
param previousImageTag = readEnvironmentVariable('PREVIOUS_IMAGE_TAG', '')
param appVersion = readEnvironmentVariable('APP_VERSION', '')
param allowedOrigins = readEnvironmentVariable('ALLOWED_ORIGINS', '')
