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
param deployApp = bool(readEnvironmentVariable('DEPLOY_APP', 'false'))
param imageTag = readEnvironmentVariable('IMAGE_TAG', '')
param revisionSuffix = readEnvironmentVariable('REVISION_SUFFIX', '')
param stableRevisionSuffix = readEnvironmentVariable('STABLE_REVISION_SUFFIX', '')
param previousRevisionSuffix = readEnvironmentVariable('PREVIOUS_REVISION_SUFFIX', '')
param allowedOrigins = readEnvironmentVariable('ALLOWED_ORIGINS', '')
