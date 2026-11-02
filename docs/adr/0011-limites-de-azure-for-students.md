# 0011 — Ajustes por los límites de Azure for Students: ambiente Express compartido, una revisión activa e identidad administrada para el pipeline

- Estado: aceptada
- Fecha: 2 de noviembre de 2026
- Modifica: [0009](0009-despliegue-en-azure.md)

## Contexto

Al activar la suscripción de Azure for Students y hacer el primer despliegue aparecieron límites que la plantilla
de la ADR 0009 no consideraba:

- **Un solo ambiente de Container Apps por suscripción.** Las suscripciones de prueba y de estudiante rechazan el
  segundo con `MaxNumberOfGlobalEnvironmentsInSubExceeded` («cannot have more than 1 Container App
  Environments»). Con un ambiente por cada uno de dev y prod, el despliegue de prod fallaría.
- **El ambiente se crea en modo Express.** El primer despliegue falló con `ExpressEnvironmentFeatureNotSupported`:
  la suscripción de estudiante crea los ambientes de Container Apps como Express. Express no tiene varias revisiones
  activas, división de tráfico, etiquetas de revisión, sufijos de revisión, referencias a Key Vault, perfiles de
  carga ni el destino de logs `azure-monitor`.
- **Regiones permitidas por política.** Cada suscripción de estudiante tiene una asignación «Allowed resource
  deployment regions» con unas cinco regiones, distintas para cada persona.
- **El tenant es el de la universidad.** Crear un registro de aplicación en Entra ID (lo que usaba `bootstrap.sh`
  para el pipeline) depende de una configuración del tenant que el estudiante no controla.
- **El subject del token de GitHub trae IDs.** El login con OIDC falló con `AADSTS700213`: GitHub mandó
  `repo:dueño@<id>/repo@<id>:environment:dev` y la credencial federada esperaba `repo:dueño/repo:environment:dev`.

## Decisión

- **Dev y prod comparten el ambiente de Container Apps** (`cae-arenal`) y el workspace de Log Analytics
  (`log-arenal`), en un grupo propio, `rg-arenal-shared`. Todo lo demás sigue separado por ambiente: identidad,
  Postgres, Redis, Key Vault, registro, Application Insights, alertas y presupuesto. Cada despliegue declara también
  lo compartido; si ya existe, no cambia nada. Los logs llegan a Log Analytics con la configuración del ambiente
  (destino `log-analytics`), no con una configuración de diagnóstico.
- **Una revisión activa y despliegue gradual.** La app usa `activeRevisionsMode: Single`. Cada despliegue crea una
  revisión nueva; Container Apps la arranca, le pasa el tráfico cuando su sonda de disponibilidad pasa y apaga la
  anterior, que cierra sus WebSocket con 1012. Los clientes reconectan solos (`ReconnectingSession`) y la partida
  sigue, porque su estado está en Postgres. La prueba de humo espera a que `/health/live` muestre la versión nueva;
  si falla, el script vuelve a la imagen anterior.
- **Rollback = la imagen anterior.** La app guarda en la etiqueta `imagenAnterior` la imagen que corría antes del
  último despliegue; `rollback.sh` la vuelve a poner (o la que se le indique) y corre la prueba de humo.
- **La app lee la llave de los JWT de Key Vault al arrancar**, con su identidad administrada y el rol `Key Vault
Secrets User`. Container Apps solo recibe la URL del secreto; el valor no pasa por la plantilla ni por la
  configuración de la app.
- **El pipeline entra con una identidad administrada asignada por el usuario** (`id-arenal-github`, en
  `rg-arenal-pipeline`), con dos credenciales federadas por environment de GitHub: una por cada formato del
  subject. Crearla solo pide permisos en la suscripción, no en el tenant.
- **`bootstrap.sh` revisa la región** contra la política de regiones permitidas antes de crear nada, y avisa si ya
  hay otro ambiente de Container Apps en la suscripción.

## Alternativas descartadas

- **Pedir más cuota o un ambiente estándar:** depende de un caso de soporte sin plazo, y la entrega es en días.
- **Solo prod en Azure:** se pierde el ambiente donde se prueba cada versión antes de aprobarla y la promoción de
  la misma imagen de dev a prod.
- **Pasar la llave como secreto de la app desde el pipeline:** funciona en Express, pero el valor viajaría en cada
  despliegue y quedaría copiado en la configuración de Container Apps.
- **Una revisión de prueba en otra app (`ca-arenal-prod-next`) para imitar el 0 % del tráfico:** duplica réplicas y
  complica el pipeline para algo que el despliegue gradual con sondas y rollback automático ya cubre.

## Consecuencias

- Se pierde probar una versión con 0 % del tráfico antes de publicarla y el lanzamiento canario. Lo compensan dev
  (cada versión pasa por ahí antes de la aprobación), la sonda de disponibilidad (una revisión que no arranca nunca
  recibe tráfico) y el rollback automático si la prueba de humo falla.
- El rollback crea una revisión nueva con la imagen anterior: tarda lo que tarda en arrancar (un par de minutos),
  no es un cambio de tráfico instantáneo.
- El ambiente de Container Apps es un límite de red y de aislamiento: dev y prod corren en la misma red interna del
  ambiente. No se exponen puertos internos (solo la entrada HTTPS de cada app) y cada app solo tiene permisos sobre
  sus propios recursos, así que una app no puede leer los datos ni los secretos de la otra. Queda anotado en el
  modelo de amenazas.
- Si Key Vault no responde al arrancar, la réplica no arranca y Container Apps la reintenta; las que ya corren no
  se ven afectadas.
- Borrar dev ya no borra el ambiente compartido: recrear dev no choca con el límite de uno, ni con un ambiente
  borrado que todavía cuenta durante un tiempo.
- El ambiente no se puede mover de región. Cambiar de región implica borrar lo compartido y volver a crearlo.
- Los logs de las dos apps quedan en el mismo workspace; las consultas filtran por `ContainerAppName_s` o por la app
  de Application Insights.
