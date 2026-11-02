// Producción: la URL que revisa el profesor. Siempre al menos 2 réplicas, para que los
// jugadores de una misma partida puedan quedar en réplicas distintas.
using 'main.bicep'

param environmentName = 'prod'
param location = readEnvironmentVariable('AZURE_LOCATION', 'eastus2')
param deployerPrincipalId = readEnvironmentVariable('DEPLOYER_PRINCIPAL_ID', '')
param alertEmail = readEnvironmentVariable('ALERT_EMAIL', '')
param monthlyBudget = 60
param budgetStartDate = '2026-11-01'
param minReplicas = 2
param maxReplicas = 4
param deployApp = bool(readEnvironmentVariable('DEPLOY_APP', 'false'))
param imageTag = readEnvironmentVariable('IMAGE_TAG', '')
param previousImageTag = readEnvironmentVariable('PREVIOUS_IMAGE_TAG', '')
param appVersion = readEnvironmentVariable('APP_VERSION', '')
param allowedOrigins = readEnvironmentVariable('ALLOWED_ORIGINS', '')
