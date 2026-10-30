// La identidad de la app como administradora de Entra ID del servidor de Postgres. Va en un
// módulo aparte porque el nombre del recurso es el principalId de la identidad, que solo se
// conoce durante el despliegue.

param serverName string
param principalId string
param principalName string

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' existing = {
  name: serverName
}

resource admin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2025-08-01' = {
  parent: postgres
  name: principalId
  properties: {
    principalType: 'ServicePrincipal'
    principalName: principalName
    tenantId: tenant().tenantId
  }
}
