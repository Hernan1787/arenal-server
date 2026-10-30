// Un ambiente completo de Arenal (dev o prod) en una sola ejecución:
//   1. deployApp=false crea el grupo de recursos y la base (registro, Key Vault, datos…).
//   2. El pipeline genera el secreto de JWT si falta y sube la imagen.
//   3. deployApp=true crea o actualiza la app en Container Apps con la imagen nueva.
// Ver docs/deploy.md.
targetScope = 'subscription'

@allowed(['dev', 'prod'])
param environmentName string

@description('Región. Debe tener Azure Managed Redis Balanced_B0 y Postgres Flexible B1ms.')
param location string

@description('Principal (objectId) de la identidad del pipeline')
param deployerPrincipalId string

@allowed(['ServicePrincipal', 'User'])
param deployerPrincipalType string = 'ServicePrincipal'

param alertEmail string

@description('Presupuesto mensual del ambiente en USD')
param monthlyBudget int

@description('Primer día del mes desde el que cuenta el presupuesto. Fijo: Azure no deja moverlo después.')
param budgetStartDate string

param redisHighAvailability bool = false

@description('false: solo la base. true: también la app (requiere la imagen en el registro).')
param deployApp bool = false

@description('Etiqueta de la imagen en el registro (el SHA del commit)')
param imageTag string = ''

param revisionSuffix string = ''
param stableRevisionSuffix string = ''
param previousRevisionSuffix string = ''
param allowedOrigins string = ''
param minReplicas int = 0
param maxReplicas int = 3

var tags = {
  proyecto: 'arenal'
  ambiente: environmentName
  curso: 'diseno-de-software-tec'
}
var suffix = take(uniqueString(subscription().id, environmentName), 6)

resource group 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: 'rg-arenal-${environmentName}'
  location: location
  tags: tags
}

module base 'modules/base.bicep' = {
  scope: group
  name: 'arenal-base-${environmentName}'
  params: {
    environmentName: environmentName
    location: location
    suffix: suffix
    deployerPrincipalId: deployerPrincipalId
    deployerPrincipalType: deployerPrincipalType
    alertEmail: alertEmail
    monthlyBudget: monthlyBudget
    budgetStartDate: budgetStartDate
    redisHighAvailability: redisHighAvailability
    tags: tags
  }
}

module app 'modules/app.bicep' = if (deployApp) {
  scope: group
  name: 'arenal-app-${environmentName}'
  params: {
    environmentName: environmentName
    location: location
    tags: tags
    image: '${base.outputs.registryServer}/arenal-server:${imageTag}'
    revisionSuffix: revisionSuffix
    stableRevisionSuffix: stableRevisionSuffix
    previousRevisionSuffix: previousRevisionSuffix
    identityId: base.outputs.identityId
    identityName: base.outputs.identityName
    identityClientId: base.outputs.identityClientId
    registryServer: base.outputs.registryServer
    vaultUri: base.outputs.vaultUri
    postgresHost: base.outputs.postgresHost
    redisHost: base.outputs.redisHost
    containerEnvId: base.outputs.containerEnvId
    containerEnvDomain: base.outputs.containerEnvDomain
    appInsightsConnectionString: base.outputs.appInsightsConnectionString
    actionGroupId: base.outputs.actionGroupId
    allowedOrigins: allowedOrigins
    minReplicas: minReplicas
    maxReplicas: maxReplicas
  }
}

output resourceGroup string = group.name
output registryName string = base.outputs.registryName
output registryServer string = base.outputs.registryServer
output vaultName string = base.outputs.vaultName
output appName string = deployApp ? app!.outputs.appName : ''
output url string = deployApp ? app!.outputs.url : ''
output nextUrl string = deployApp ? app!.outputs.nextUrl : ''
output newRevision string = deployApp ? app!.outputs.newRevision : ''
