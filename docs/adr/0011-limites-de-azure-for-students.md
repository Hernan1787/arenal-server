# 0011 — Ajustes por los límites de Azure for Students: un ambiente de Container Apps compartido e identidad administrada para el pipeline

- Estado: aceptada
- Fecha: 2 de noviembre de 2026
- Modifica: [0009](0009-despliegue-en-azure.md)

## Contexto

Al activar la suscripción de Azure for Students, antes del primer despliegue, aparecieron tres límites que la
plantilla de la ADR 0009 no consideraba:

- **Un solo ambiente de Container Apps por suscripción.** Las suscripciones de prueba y de estudiante rechazan el
  segundo con `MaxNumberOfGlobalEnvironmentsInSubExceeded` («cannot have more than 1 Container App
  Environments»). Con un ambiente por cada uno de dev y prod, el despliegue de prod fallaría.
- **Regiones permitidas por política.** Cada suscripción de estudiante tiene una asignación «Allowed resource
  deployment regions» con unas cinco regiones, distintas para cada persona.
- **El tenant es el de la universidad.** Crear un registro de aplicación en Entra ID (lo que usaba `bootstrap.sh`
  para el pipeline) depende de una configuración del tenant que el estudiante no controla.

## Decisión

- **Dev y prod comparten el ambiente de Container Apps** (`cae-arenal`) y el workspace de Log Analytics
  (`log-arenal`), en un grupo propio, `rg-arenal-shared`. Todo lo demás sigue separado por ambiente: identidad,
  Postgres, Redis, Key Vault, registro, Application Insights, alertas y presupuesto. Cada despliegue declara también
  lo compartido; si ya existe, no cambia nada.
- **El pipeline entra con una identidad administrada asignada por el usuario** (`id-arenal-github`, en
  `rg-arenal-pipeline`) con una credencial federada por environment de GitHub. Funciona igual que antes con
  `azure/login` y OIDC, pero crearla solo pide permisos en la suscripción, no en el tenant.
- **`bootstrap.sh` revisa la región** contra la política de regiones permitidas antes de crear nada, y avisa si ya
  hay otro ambiente de Container Apps en la suscripción.

## Alternativas descartadas

- **Pedir más cuota de ambientes:** depende de un caso de soporte sin plazo, y la entrega es en días.
- **Solo prod en Azure:** se pierde el ambiente donde se prueba cada versión antes de aprobarla y la promoción de
  la misma imagen de dev a prod.
- **Un solo ambiente con dos revisiones de la misma app:** mezclaría la base de datos y los secretos de dev y prod.

## Consecuencias

- El ambiente de Container Apps es un límite de red y de aislamiento: dev y prod corren en la misma red interna del
  ambiente. No se exponen puertos internos (solo la entrada HTTPS de cada app) y cada app solo tiene permisos sobre
  sus propios recursos, así que una app no puede leer los datos ni los secretos de la otra. Queda anotado en el
  modelo de amenazas.
- Borrar dev ya no borra el ambiente compartido: recrear dev no choca con el límite de uno, ni con un ambiente
  borrado que todavía cuenta durante un tiempo.
- El ambiente no se puede mover de región. Cambiar de región implica borrar lo compartido y volver a crearlo.
- Los logs de las dos apps quedan en el mismo workspace; las consultas filtran por `ContainerAppName` o por la app
  de Application Insights.
