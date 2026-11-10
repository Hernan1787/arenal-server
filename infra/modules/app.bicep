// El servidor en Container Apps. El ambiente es Express (ADR 0011): una sola revisión activa a la
// vez. Cada despliegue crea una revisión nueva (cambia la imagen o APP_VERSION); Container Apps la
// arranca, espera a que pase la sonda de disponibilidad, le pasa el tráfico y apaga la anterior.
// Al apagarse, cada réplica vieja cierra sus WebSocket con 1012 y los clientes reconectan a la
// nueva. La imagen anterior queda anotada en una etiqueta del recurso para el rollback
// (infra/scripts/rollback.sh).

param environmentName string
param location string
param tags object = {}

@description('Imagen completa, por ejemplo acrarenaldev123.azurecr.io/arenal-server:<sha>')
param image string

@description('Imagen que estaba antes de este despliegue (vacío la primera vez); se guarda para el rollback')
param previousImage string = ''

@description('Versión que muestra /health/live; distinta en cada despliegue')
param appVersion string

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

@description('Límites de peticiones muy altos, para la prueba de carga desde una sola IP. Solo en dev.')
param relaxedRateLimits bool = false

// Con un solo generador de carga, todos los usuarios de prueba vienen de la misma IP.
var loadTestEnv = relaxedRateLimits
  ? [
      { name: 'RATE_LIMIT_AUTH_PER_MINUTE', value: '100000' }
      { name: 'RATE_LIMIT_TICKETS_PER_MINUTE', value: '100000' }
      { name: 'RATE_LIMIT_USER_PER_MINUTE', value: '100000' }
    ]
  : []

var appName = 'ca-arenal-${environmentName}'
var publicUrl = 'https://${appName}.${containerEnvDomain}'

resource app 'Microsoft.App/containerApps@2025-07-01' = {
  name: appName
  location: location
  tags: union(tags, { imagen: image, imagenAnterior: previousImage })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    environmentId: containerEnvId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
      }
      registries: [{ server: registryServer, identity: identityId }]
    }
    template: {
      // Express no deja cambiar el plazo de apagado; el de Container Apps es de 30 s y el servidor
      // drena en 25 (SHUTDOWN_GRACE_MS): cierra los WebSocket con 1012 y los clientes reconectan a la
      // revisión nueva.
      containers: [
        {
          name: 'server'
          image: image
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: concat([
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '8080' }
            { name: 'APP_VERSION', value: appVersion }
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
            // Solo la URL: la app lee la llave de Key Vault al arrancar, con su identidad.
            { name: 'JWT_PRIVATE_KEY_SECRET_URI', value: '${vaultUri}secrets/jwt-private-key' }
            // Con la ingesta local desactivada, esta cadena no sirve sin un token de Entra ID.
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
          ], loadTestEnv)
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
output latestRevision string = app.properties.latestRevisionName
