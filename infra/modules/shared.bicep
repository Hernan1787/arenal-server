// Lo que comparten dev y prod (grupo rg-arenal-shared): el ambiente de Container Apps y el
// workspace de Log Analytics. Las suscripciones de estudiante permiten un solo ambiente de
// Container Apps, así que las dos apps (ca-arenal-dev y ca-arenal-prod) viven en el mismo,
// cada una con su identidad, sus datos y sus secretos en su propio grupo. Ver ADR 0011.

param location string
param tags object = {}

// Logs de las dos apps y la telemetría de los dos Application Insights: todo se consulta con KQL
// en un solo lugar (filtrando por app o por ambiente).
resource logs 'Microsoft.OperationalInsights/workspaces@2025-07-01' = {
  name: 'log-arenal'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: 1 }
  }
}

// Los logs van a Log Analytics por una configuración de diagnóstico, sin la llave del workspace.
resource containerEnv 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: 'cae-arenal'
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

output logsWorkspaceId string = logs.id
output containerEnvId string = containerEnv.id
output containerEnvDomain string = containerEnv.properties.defaultDomain
