# Despliegue en Azure

Todo lo de Azure está en [`infra/`](../infra): la plantilla Bicep, los parámetros de cada ambiente y los scripts que
usa el pipeline. Un ambiente se crea completo, desde cero, con una sola ejecución de
[`infra/scripts/deploy.sh`](../infra/scripts/deploy.sh), que es lo que corre el workflow
[Despliegue](../.github/workflows/deploy.yml).

## Arquitectura

```
Jugadores ──HTTPS / WSS──▶ Container Apps (ca-arenal-<amb>, 2+ réplicas, revisiones múltiples)
                              │  identidad administrada id-arenal-<amb>
                              ├──▶ PostgreSQL Flexible B1ms   (token de Entra ID, TLS; sin contraseñas)
                              ├──▶ Azure Managed Redis B0     (token de Entra ID, TLS, sin agrupar; sin llaves)
                              ├──▶ Key Vault                  (llave de firma de los JWT)
                              ├──▶ Container Registry Basic   (imagen, sin usuario administrador)
                              └──▶ Application Insights       (ingesta solo con Entra ID)
                           Log Analytics ◀── logs del ambiente de Container Apps
```

| Recurso                     | Nombre                                              | Para qué                                        |
| --------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| Grupo de recursos           | `rg-arenal-<amb>`                                   | Todo el ambiente; borrarlo borra todo           |
| Identidad administrada      | `id-arenal-<amb>`                                   | La única identidad de la app                    |
| Container Apps              | `cae-arenal-<amb>`, `ca-arenal-<amb>`               | El servidor; revisiones con división de tráfico |
| PostgreSQL Flexible         | `psql-arenal-<amb>-<sufijo>`                        | Partidas, eventos, usuarios, auditoría          |
| Azure Managed Redis         | `redis-arenal-<amb>-<sufijo>`                       | Pub/sub entre réplicas, tickets, presencia      |
| Key Vault                   | `kv-arenal-<amb>-<sufijo>`                          | `jwt-private-key`, generada por el pipeline     |
| Container Registry          | `acrarenal<amb><sufijo>`                            | Imágenes `arenal-server:<sha>`                  |
| Log Analytics, App Insights | `log-arenal-<amb>`, `appi-arenal-<amb>`             | Logs, trazas y métricas                         |
| Alertas y presupuesto       | `ag-arenal-<amb>`, `alert-…`, `budget-arenal-<amb>` | Correo al equipo                                |

### Quién accede a qué

Ninguna conexión usa contraseñas, llaves ni cadenas de conexión con credenciales.

| Quién                        | Sobre qué            | Cómo                                                                             |
| ---------------------------- | -------------------- | -------------------------------------------------------------------------------- |
| Identidad de la app          | PostgreSQL           | Administradora de Entra ID del servidor; la contraseña es un token de 1 h        |
| Identidad de la app          | Redis                | Política de acceso `default`; el usuario es su object ID, la contraseña un token |
| Identidad de la app          | Key Vault            | `Key Vault Secrets User` (solo lee el secreto)                                   |
| Identidad de la app          | Registro             | `AcrPull`                                                                        |
| Identidad de la app          | Application Insights | `Monitoring Metrics Publisher`                                                   |
| Pipeline (OIDC desde GitHub) | Suscripción          | `Contributor` y `Role Based Access Control Administrator`                        |
| Pipeline                     | Key Vault, registro  | `Key Vault Secrets Officer` (crea el secreto), `AcrPush`                         |

El único secreto del sistema es la llave privada ES256 de los JWT. La genera `deploy.sh` con `openssl` dentro del
runner la primera vez y la escribe directo en Key Vault; Container Apps la lee con la identidad (referencia de
secreto) y el valor nunca aparece en la plantilla, en los logs ni en el repo.

## Preparación (una sola vez)

La hace quien es dueño de la suscripción de Azure for Students.

1. Elegir una región que tenga **Azure Managed Redis Balanced B0** y **PostgreSQL Flexible B1ms**. Algunas
   suscripciones de estudiante solo permiten ciertas regiones: se ve en
   _Directiva > Ubicaciones permitidas_ o al intentar crear el recurso en el portal.
2. Abrir **Azure Cloud Shell** (Bash), clonar el repo y correr:

   ```bash
   git clone https://github.com/Hernan1787/arenal-server && cd arenal-server
   infra/scripts/bootstrap.sh Hernan1787/arenal-server <región> <correo-de-alertas> Hernan1787 <usuario-de-github-del-compañero>
   ```

   El script registra los proveedores de recursos, crea la identidad del pipeline en Entra ID (sin contraseña: GitHub
   entra con OIDC, con una credencial federada por environment), le da permisos sobre la suscripción, crea los
   environments `dev` y `prod` de GitHub (prod con los revisores indicados) y guarda las variables.

3. Correr **Actions > Despliegue > Run workflow** (o hacer push a `main`). La primera vez crea dev completo: tarda
   unos 15 minutos, casi todo en crear Postgres y Redis. Después espera la aprobación de prod.

## Qué hace cada despliegue

Cuando el CI de `main` pasa, el workflow corre `deploy.sh dev`, y después de la aprobación manual, `deploy.sh prod`:

1. **Base:** crea o actualiza el grupo de recursos y todo lo que no es la app. Si el ambiente no existía, purga
   antes un Key Vault borrado con el mismo nombre (quedan retenidos 7 días).
2. **Secreto:** si `jwt-private-key` no existe en Key Vault, lo genera. Si existe, no lo toca.
3. **Imagen:** dev construye la imagen y la sube a su registro. Prod **importa la misma imagen** que pasó por dev
   (`az acr import`): lo que se aprueba es exactamente lo que se probó.
4. **Revisión nueva** `ca-arenal-<amb>--c<sha>-<corrida>` con **0 % del tráfico** y la etiqueta `next`.
5. **Prueba de humo** contra la URL propia de la revisión nueva (`…---next.<dominio>`): `/health/ready`, `/docs`,
   registro (Postgres y la llave de Key Vault), ticket (Redis) y apertura del WebSocket. Si falla, la revisión se
   apaga y producción sigue igual.
6. **Promoción:** la revisión nueva recibe el 100 % y la anterior queda marcada como `previous`. Pasados 60 s, las
   revisiones viejas se apagan.

### Sin cortar partidas

- El estado de cada partida vive en Postgres, no en la réplica. Una réplica puede desaparecer en cualquier momento.
- Al cambiar el tráfico, las conexiones nuevas van a la revisión nueva. Al apagarse la vieja, cada réplica recibe
  `SIGTERM`, deja de aceptar conexiones (503 en `/health/ready`) y cierra cada WebSocket con **1012**. El cliente
  reconecta con un ticket nuevo, cae en la revisión nueva y recibe el `snapshot` de su partida. El periodo de gracia
  (60 s) cubre la reconexión de sobra.
- Las migraciones tienen que ser **compatibles hacia atrás** (agregar columnas o tablas, nunca renombrar ni borrar
  en el mismo despliegue): durante el cambio conviven dos versiones del servidor sobre la misma base.

## Rollback (menos de 5 minutos)

La revisión anterior sigue existiendo y su imagen sigue en el registro.

- **Con el pipeline:** _Actions > Rollback > Run workflow_, ambiente `prod`. Reactiva la revisión `previous`,
  espera a que esté sana, le devuelve el 100 % del tráfico y corre la prueba de humo. Imprime cuánto tardó.
- **Desde Cloud Shell:** `infra/scripts/rollback.sh prod` (o `rollback.sh prod <revisión>` para elegir otra).
- **A mano en el portal:** _Container App > Revisiones y réplicas_: activar la revisión anterior y, en
  _Tráfico_, ponerle 100 %.

El rollback no toca la base de datos, porque las migraciones son compatibles hacia atrás.

## Reconstruir un ambiente desde cero

```bash
infra/scripts/destroy.sh dev --yes   # borra rg-arenal-dev y purga su Key Vault
# Actions > Despliegue > Run workflow: lo vuelve a crear completo
```

## Costo mensual estimado

Precios de lista aproximados en USD para una región de EE. UU. Pueden variar por región; conviene confirmarlos en
la [calculadora de Azure](https://azure.microsoft.com/pricing/calculator/) y en _Cost Management_ los primeros días.

| Recurso                      | Configuración                           | dev                | prod                       |
| ---------------------------- | --------------------------------------- | ------------------ | -------------------------- |
| PostgreSQL Flexible          | B1ms, 32 GB, sin alta disponibilidad    | ~16                | ~16                        |
| Azure Managed Redis          | Balanced B0, sin alta disponibilidad    | ~12                | ~12                        |
| Container Apps (consumo)     | 0.25 vCPU / 0.5 GiB por réplica         | ~0 (escala a cero) | 10 a 34 (2 réplicas fijas) |
| Container Registry           | Basic                                   | ~5                 | ~5                         |
| Log Analytics + App Insights | Retención 30 días, tope de 1 GB por día | ~1                 | ~2                         |
| Key Vault                    | Standard, un secreto                    | <1                 | <1                         |
| **Total**                    |                                         | **~34**            | **45 a 69**                |

- En Container Apps, una réplica inactiva (sin solicitudes, menos de 0.01 vCPU y menos de 1000 B/s de red) se cobra
  a una tarifa reducida; por eso el barrido corre cada 2 s en Azure. Las primeras 180 000 vCPU·s y 360 000 GiB·s de
  cada mes son gratis.
- **Para que alcance el crédito:** dev solo existe mientras se prueba (`destroy.sh dev --yes` al terminar; el
  pipeline lo recrea). Prod puede bajar a 1 réplica fuera de las demostraciones
  (`az containerapp update -g rg-arenal-prod -n ca-arenal-prod --min-replicas 1`).
- Cada ambiente tiene un presupuesto (35 USD dev, 60 USD prod) que avisa por correo al 50 % del gasto real y cuando
  el pronóstico pasa el 100 %.

## Alertas

| Alerta                                | Condición                                                                                            | Severidad |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------- |
| `alert-ca-arenal-<amb>-5xx`           | Más de 10 respuestas 5xx en 5 minutos                                                                | 1         |
| `alert-ca-arenal-<amb>-reinicios`     | Alguna réplica se reinició en 15 minutos                                                             | 2         |
| `alert-arenal-<amb>-postgres-cpu`     | CPU de Postgres sobre 80 % durante 10 min                                                            | 2         |
| `alert-arenal-<amb>-latencia-jugadas` | Jugadas con más de 100 ms promedio en el servidor durante 5 min ([observabilidad](observability.md)) | 2         |

Todas avisan por correo al grupo de acciones `ag-arenal-<amb>`.

## Problemas conocidos

- **Permisos recién asignados:** Azure tarda unos minutos en aplicar un rol nuevo. `deploy.sh` reintenta los pasos
  que dependen de eso (secreto, registro). Si el primer despliegue falla por un 403, volver a correrlo suele bastar.
- **Base de datos y migraciones:** la plantilla no crea la base `arenal`; la crea la app al arrancar, conectada
  como su identidad (administradora de Entra ID del servidor). Así la identidad es dueña de la base y del esquema
  `public`, y las migraciones no necesitan permisos extra. Si dos réplicas arrancan a la vez, una crea la base y la
  otra la encuentra; un candado de Postgres hace que solo una migre.
- **Región sin Managed Redis B0:** cambiar `AZURE_LOCATION` en las variables del repo y volver a desplegar.
