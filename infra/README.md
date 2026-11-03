# Infraestructura (Bicep)

| Archivo                             | Qué tiene                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `main.bicep`                        | Punto de entrada (ámbito de suscripción): grupos de recursos y módulos de un ambiente         |
| `modules/shared.bicep`              | Lo compartido por dev y prod: ambiente de Container Apps y Log Analytics (`rg-arenal-shared`) |
| `modules/base.bicep`                | Lo de cada ambiente: identidad, registro, Key Vault, Postgres, Redis, App Insights, alertas   |
| `modules/postgres-admin.bicep`      | La identidad de la app como administradora de Entra ID de Postgres                            |
| `modules/app.bicep`                 | La Container App: una revisión activa (modo Express), sondas, escalado y alertas de la app    |
| `dev.bicepparam`, `prod.bicepparam` | Parámetros de cada ambiente                                                                   |
| `scripts/bootstrap.sh`              | Preparación única: región, proveedores, identidad del pipeline y environments de GitHub       |
| `scripts/deploy.sh`                 | Despliegue completo de un ambiente (lo usa el workflow Despliegue)                            |
| `scripts/rollback.sh`               | Vuelve a la imagen anterior al último despliegue y corre la prueba de humo                    |
| `scripts/destroy.sh`                | Borra un ambiente (o lo compartido) para no gastar crédito                                    |
| `scripts/smoke.mjs`                 | Prueba de humo contra una URL desplegada                                                      |

Cómo se usa, la arquitectura y los costos: [docs/deploy.md](../docs/deploy.md). Decisiones:
[ADR 0009](../docs/adr/0009-despliegue-en-azure.md) y [ADR 0011](../docs/adr/0011-limites-de-azure-for-students.md).
