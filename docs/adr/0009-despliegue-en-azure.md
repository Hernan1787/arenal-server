# 0009 — Despliegue en Azure: Container Apps, identidad administrada y revisiones con tráfico dividido

- Estado: aceptada
- Fecha: 29 de octubre de 2026

## Contexto

El servidor tiene que correr en Azure con varias réplicas, sin ninguna contraseña ni llave en la configuración, con
dev automático y prod con aprobación manual, publicaciones que no corten partidas y un rollback de menos de 5
minutos. Todo dentro del crédito de Azure for Students, y con un ambiente nuevo que se levanta en una sola
ejecución del pipeline.

## Decisión

- **Container Apps en plan de consumo** (topología de referencia). Soporta WebSocket, escala a cero en dev y tiene
  revisiones con división de tráfico, que es lo que permite publicar sin cortar partidas.
- **Una identidad administrada asignada por el usuario** para todo: Postgres y Redis con tokens de Entra ID, Key
  Vault con una referencia de secreto, el registro con `AcrPull` y Application Insights con ingesta solo por Entra
  ID. Asignada por el usuario (y no por el sistema) para que exista antes que la app y la plantilla le pueda dar
  permisos en el mismo despliegue.
- **Postgres solo con Entra ID** (autenticación por contraseña desactivada) y **Redis sin llaves de acceso**. La
  base la crea la app al arrancar, así su identidad es la dueña y migra sin permisos extra.
- **Redis con RESP3.** En RESP2 una conexión suscrita a pub/sub no puede renovar su token sin reconectar; en RESP3
  sí. Las pruebas corren con RESP3 también en local.
- **Bicep en el ámbito de la suscripción.** `main.bicep` crea el grupo de recursos y dos módulos: la base y la app.
  El pipeline corre la base, genera el secreto de JWT si falta (directo a Key Vault), sube la imagen y recién
  después despliega la app. Todo vive en `infra/scripts/deploy.sh` para poder correrlo igual desde el pipeline o
  desde Cloud Shell.
- **GitHub con OIDC.** El pipeline entra a Azure con una credencial federada por environment, sin secretos de
  Azure guardados. `prod` es un environment con revisores obligatorios: esa es la aprobación manual.
- **Revisión nueva con 0 % del tráfico, prueba de humo y promoción.** Prod importa la misma imagen que pasó por dev.
  La revisión anterior queda marcada como `previous`; el rollback la reactiva y le devuelve el tráfico.

## Alternativas descartadas

- **App Service con WebSockets:** no tiene revisiones con tráfico dividido por etiqueta, y escalar a cero no existe.
- **Azure Web PubSub:** sacaría las conexiones del servidor, pero el reparto filtrado por jugador y el relleno de
  huecos ya están resueltos en el gateway; sería otro servicio más que pagar.
- **Red privada (VNet, endpoints privados):** más segura, pero los endpoints privados y el ambiente con VNet suben
  el costo y la complejidad más allá del crédito. Se compensa con TLS obligatorio y autenticación solo por Entra ID;
  queda en el modelo de amenazas como riesgo aceptado.
- **Dejar activa la revisión anterior:** hace el rollback instantáneo, pero en prod paga dos réplicas más. Se apaga
  después de la promoción y el rollback la reactiva en un par de minutos.

## Consecuencias

- Un ambiente nuevo tarda unos 15 minutos en crearse (Postgres y Redis); los despliegues siguientes, unos 5.
- Las migraciones tienen que ser compatibles hacia atrás: durante la promoción conviven dos versiones.
- La identidad de la app es administradora de Entra ID de Postgres, así que es dueña de las tablas. Separar el rol
  que migra del rol que atiende solicitudes queda como mejora (ADR 0008).
- Sin red privada, Postgres acepta conexiones desde servicios de Azure. Sin un token válido del tenant no se entra.
