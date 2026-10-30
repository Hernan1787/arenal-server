// El servidor en Container Apps. Cada despliegue crea una revisión nueva (`<app>--<sufijo>`):
// si ya hay una revisión estable, la nueva entra con 0 % del tráfico y la etiqueta `next`; el
// pipeline la prueba por su URL propia y recién entonces le pasa el tráfico. La revisión vieja
// queda marcada como `previous`: un rollback es reactivarla y devolverle el tráfico
// (infra/scripts/rollback.sh).

param environmentName string
param location string
param tags object = {}

@description('Imagen completa, por ejemplo acrarenaldev123.azurecr.io/arenal-server:<sha>')
param image string

@description('Sufijo de la revisión (por ejemplo el SHA corto del commit)')
param revisionSuffix string

@description('Sufijo de la revisión que hoy recibe el tráfico. Vacío en el primer despliegue.')
param stableRevisionSuffix string = ''

@description('Sufijo de la revisión anterior, marcada como `previous` para el rollback')
param previousRevisionSuffix string = ''

param identityId string
param identityName string
param identityClientId string
param registryServer string
param vaultUri string
param postgresHost string
param redisHost string
param containerEnvId string
param containerEnvDomain string
param appInsightsConnectionString string
param actionGroupId string

@description('Orígenes de navegador permitidos (CORS y WebSocket), separados por coma')
param allowedOrigins string = ''

@minValue(0)
param minReplicas int

@minValue(1)
param maxReplicas int

var appName = 'ca-arenal-${environmentName}'
var publicUrl = 'https://${appName}.${containerEnvDomain}'
var newRevision = '${appName}--${revisionSuffix}'
// Directo: primer despliegue, o la promoción (la revisión nueva ya pasó la prueba de humo).
var direct = empty(stableRevisionSuffix) || stableRevisionSuffix == revisionSuffix
var keepPrevious = !empty(previousRevisionSuffix) && previousRevisionSuffix != revisionSuffix && previousRevisionSuffix != stableRevisionSuffix

var mainTraffic = direct
  ? [{ revisionName: newRevision, weight: 100, label: 'stable' }]
  : [
      { revisionName: '${appName}--${stableRevisionSuffix}', weight: 100, label: 'stable' }
      { revisionName: newRevision, weight: 0, label: 'next' }
    ]
var traffic = concat(
  mainTraffic,
  keepPrevious ? [{ revisionName: '${appName}--${previousRevisionSuffix}', weight: 0, label: 'previous' }] : []
)

resource app 'Microsoft.App/containerApps@2025-07-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    environmentId: containerEnvId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Multiple'
      maxInactiveRevisions: 5
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        traffic: traffic
      }
      registries: [{ server: registryServer, identity: identityId }]
      // Referencia a Key Vault leída con la identidad: el valor nunca aparece en la plantilla.
      secrets: [
        {
          name: 'jwt-private-key'
          keyVaultUrl: '${vaultUri}secrets/jwt-private-key'
          identity: identityId
        }
      ]
    }
    template: {
      revisionSuffix: revisionSuffix
      // El servidor drena en 25 s (SHUTDOWN_GRACE_MS): cierra los WebSocket con 1012 y los
      // clientes reconectan a otra réplica.
      terminationGracePeriodSeconds: 30
      containers: [
        {
          name: 'server'
          image: image
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '8080' }
            { name: 'APP_VERSION', value: revisionSuffix }
            // Barrido cada 2 s: suficiente para turnos de 30 s y deja que las réplicas sin jugadores
            // se cobren a la tarifa reducida de inactividad.
            { name: 'SWEEP_INTERVAL_MS', value: '2000' }
            { name: 'PUBLIC_BASE_URL', value: publicUrl }
            { name: 'ALLOWED_ORIGINS', value: empty(allowedOrigins) ? publicUrl : allowedOrigins }
            { name: 'AZURE_CLIENT_ID', value: identityClientId }
            { name: 'PG_HOST', value: postgresHost }
            { name: 'PG_DATABASE', value: 'arenal' }
            { name: 'PG_USER', value: identityName }
            { name: 'PG_SSL', value: 'true' }
            { name: 'PG_AUTH', value: 'entra' }
            { name: 'REDIS_HOST', value: redisHost }
            { name: 'REDIS_PORT', value: '10000' }
            { name: 'REDIS_TLS', value: 'true' }
            { name: 'REDIS_AUTH', value: 'entra' }
            { name: 'JWT_PRIVATE_KEY', secretRef: 'jwt-private-key' }
            // Con la ingesta local desactivada, esta cadena no sirve sin un token de Entra ID.
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/health/live', port: 8080 }
              periodSeconds: 2
              failureThreshold: 30
            }
            {
              type: 'Liveness'
              httpGet: { path: '/health/live', port: 8080 }
              periodSeconds: 10
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health/ready', port: 8080 }
              periodSeconds: 5
              failureThreshold: 2
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'conexiones'
            http: { metadata: { concurrentRequests: '200' } }
          }
        ]
      }
    }
  }
}

// --- Alertas de la app -----------------------------------------------------------------------

resource errors5xx 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-${appName}-5xx'
  location: 'global'
  tags: tags
  properties: {
    description: 'Más de 10 respuestas 5xx en 5 minutos'
    severity: 1
    enabled: true
    scopes: [app.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'errores5xx'
          metricName: 'Requests'
          dimensions: [{ name: 'statusCodeCategory', operator: 'Include', values: ['5xx'] }]
          operator: 'GreaterThan'
          threshold: 10
          timeAggregation: 'Total'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroupId }]
  }
}

resource restarts 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-${appName}-reinicios'
  location: 'global'
  tags: tags
  properties: {
    description: 'Una réplica se reinició (falló la sonda o se cayó el proceso)'
    severity: 2
    enabled: true
    scopes: [app.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'reinicios'
          metricName: 'RestartCount'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Total'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroupId }]
  }
}

output appName string = app.name
output url string = publicUrl
output newRevision string = newRevision
@description('URL de la revisión nueva mientras no recibe tráfico (igual a url si fue directo)')
output nextUrl string = direct ? publicUrl : 'https://${appName}---next.${containerEnvDomain}'
