// Recursos de un ambiente que no cambian con cada versión del servidor: identidad, registro,
// secretos, datos, observabilidad, el ambiente de Container Apps y el presupuesto.
// Ninguna conexión usa contraseñas ni llaves: todo entra con la identidad administrada.

@description('dev o prod')
param environmentName string

param location string

@description('Sufijo único y estable para los nombres globales')
param suffix string

@description('Principal (objectId) que despliega: puede subir imágenes y escribir el secreto de JWT')
param deployerPrincipalId string

@description('Tipo del principal que despliega')
@allowed(['ServicePrincipal', 'User'])
param deployerPrincipalType string = 'ServicePrincipal'

@description('Correo que recibe las alertas y los avisos de presupuesto')
param alertEmail string

@description('Presupuesto mensual del ambiente en USD')
param monthlyBudget int

@description('Primer día del mes en que empieza a contar el presupuesto')
param budgetStartDate string

@description('Alta disponibilidad de Redis (duplica el costo). Solo en prod si el crédito alcanza.')
param redisHighAvailability bool = false

param tags object = {}

var name = 'arenal-${environmentName}'

// --- Identidad -------------------------------------------------------------------------------

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'id-${name}'
  location: location
  tags: tags
}

// --- Observabilidad --------------------------------------------------------------------------

resource logs 'Microsoft.OperationalInsights/workspaces@2025-07-01' = {
  name: 'log-${name}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: 1 }
  }
}

// Sin llave de ingesta: la telemetría entra solo con Entra ID (la identidad de la app).
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${name}'
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    DisableLocalAuth: true
    RetentionInDays: 30
  }
}

// --- Registro de imágenes ---------------------------------------------------------------------

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: replace('acr${name}${suffix}', '-', '')
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
  }
}

// --- Secretos --------------------------------------------------------------------------------

// Solo guarda la llave de firma de los JWT. La genera el pipeline y nunca pasa por el repo.
resource vault 'Microsoft.KeyVault/vaults@2025-05-01' = {
  name: 'kv-${name}-${suffix}'
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

// --- PostgreSQL ------------------------------------------------------------------------------

// Solo autenticación de Entra ID: no existe ninguna contraseña de base de datos.
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: 'psql-${name}-${suffix}'
  location: location
  tags: tags
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '17'
    storage: { storageSizeGB: 32, autoGrow: 'Disabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: tenant().tenantId
    }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

// La identidad de la app es la administradora de Entra ID del servidor: con ella corre las
// migraciones y las consultas. El nombre de usuario en Postgres es el nombre de la identidad.
// La base `arenal` no la crea la plantilla: la crea la app al arrancar, así es su dueña.
module postgresAdmin 'postgres-admin.bicep' = {
  name: 'postgres-admin-${environmentName}'
  params: {
    serverName: postgres.name
    principalId: identity.properties.principalId
    principalName: identity.name
  }
}

// Acceso desde servicios de Azure (Container Apps de consumo no tiene IP fija). Sin contraseñas
// y con TLS obligatorio, solo entra quien tenga un token de Entra ID de este tenant.
resource postgresAzureAccess 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2025-08-01' = {
  parent: postgres
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
  dependsOn: [postgresAdmin]
}

// --- Redis -----------------------------------------------------------------------------------

// Azure Managed Redis sin agrupar (pub/sub y MULTI funcionan igual que en local) y sin llaves:
// solo Entra ID.
resource redis 'Microsoft.Cache/redisEnterprise@2025-07-01' = {
  name: 'redis-${name}-${suffix}'
  location: location
  tags: tags
  sku: { name: 'Balanced_B0' }
  properties: {
    minimumTlsVersion: '1.2'
    highAvailability: redisHighAvailability ? 'Enabled' : 'Disabled'
    publicNetworkAccess: 'Enabled'
  }
}

resource redisDb 'Microsoft.Cache/redisEnterprise/databases@2025-07-01' = {
  parent: redis
  name: 'default'
  properties: {
    clientProtocol: 'Encrypted'
    port: 10000
    clusteringPolicy: 'NoCluster'
    // Tickets y presencia no pueden desaparecer por memoria: mejor un error que un desalojo.
    evictionPolicy: 'NoEviction'
    accessKeysAuthentication: 'Disabled'
  }
}

resource redisAccess 'Microsoft.Cache/redisEnterprise/databases/accessPolicyAssignments@2025-07-01' = {
  parent: redisDb
  name: 'arenalapp'
  properties: {
    accessPolicyName: 'default'
    user: { objectId: identity.properties.principalId }
  }
}

// --- Permisos --------------------------------------------------------------------------------

// IDs públicos de los roles integrados de Azure (son iguales en todos los tenants).
var roles = {
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  acrPush: '8311e382-0749-4cb8-b61a-304f252e45ec'
  // «Key Vault Secrets User»: lee secretos.
  vaultReader: '4633458b-17de-408a-b874-0445c86b69e6'
  // «Key Vault Secrets Officer»: crea y actualiza secretos.
  vaultWriter: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  monitoringMetricsPublisher: '3913510d-42f4-4e42-8a64-420c390055eb'
}

resource appPullsImages 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, identity.id, roles.acrPull)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource appReadsSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, identity.id, roles.vaultReader)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.vaultReader)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource appPublishesTelemetry 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: appInsights
  name: guid(appInsights.id, identity.id, roles.monitoringMetricsPublisher)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.monitoringMetricsPublisher)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource deployerPushesImages 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, deployerPrincipalId, roles.acrPush)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPush)
    principalId: deployerPrincipalId
    principalType: deployerPrincipalType
  }
}

resource deployerWritesSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, deployerPrincipalId, roles.vaultWriter)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.vaultWriter)
    principalId: deployerPrincipalId
    principalType: deployerPrincipalType
  }
}

// --- Container Apps --------------------------------------------------------------------------

// Los logs van a Log Analytics por una configuración de diagnóstico, sin la llave del workspace.
resource containerEnv 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: 'cae-${name}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: { destination: 'azure-monitor' }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    zoneRedundant: false
  }
}

resource containerEnvLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: containerEnv
  name: 'logs'
  properties: {
    workspaceId: logs.id
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

// --- Alertas y presupuesto -------------------------------------------------------------------

resource alerts 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-${name}'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: take('arenal${environmentName}', 12)
    enabled: true
    emailReceivers: [{ name: 'equipo', emailAddress: alertEmail, useCommonAlertSchema: true }]
  }
}

resource postgresCpuAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-${name}-postgres-cpu'
  location: 'global'
  tags: tags
  properties: {
    description: 'Postgres pasa de 80 % de CPU durante 10 minutos'
    severity: 2
    enabled: true
    scopes: [postgres.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT10M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'cpu'
          metricName: 'cpu_percent'
          operator: 'GreaterThan'
          threshold: 80
          timeAggregation: 'Average'
        }
      ]
    }
    actions: [{ actionGroupId: alerts.id }]
  }
}

// Métrica propia del servidor (OpenTelemetry → Application Insights): tiempo de aplicar una
// jugada, desde que se bloquea la partida hasta que se avisa a las réplicas.
resource latencyAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: 'alert-${name}-latencia-jugadas'
  location: location
  tags: tags
  properties: {
    displayName: 'Arenal ${environmentName}: jugadas lentas'
    description: 'El tiempo promedio de aplicar una jugada pasa de 100 ms durante 5 minutos (la meta de p95 es 200 ms)'
    severity: 2
    enabled: true
    scopes: [appInsights.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: 'customMetrics | where name == "arenal.intent.duration" and tostring(customDimensions["arenal.intent"]) == "play_card" | summarize promedio = sum(valueSum) / sum(valueCount)'
          timeAggregation: 'Average'
          metricMeasureColumn: 'promedio'
          operator: 'GreaterThan'
          threshold: 100
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [alerts.id] }
  }
}

resource budget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: 'budget-${name}'
  properties: {
    category: 'Cost'
    amount: monthlyBudget
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    notifications: {
      half: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: [alertEmail]
      }
      projected: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: [alertEmail]
      }
    }
  }
}

// --- Salidas ---------------------------------------------------------------------------------

output identityId string = identity.id
output identityName string = identity.name
output identityClientId string = identity.properties.clientId
output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output redisHost string = redis.properties.hostName
output containerEnvId string = containerEnv.id
output containerEnvDomain string = containerEnv.properties.defaultDomain
output appInsightsConnectionString string = appInsights.properties.ConnectionString
output appInsightsId string = appInsights.id
output actionGroupId string = alerts.id
