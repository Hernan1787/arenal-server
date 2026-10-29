# 0003 — Azure Managed Redis en lugar de Azure Cache for Redis

- Estado: aceptada
- Fecha: 29 de octubre de 2026

## Contexto

La topología de referencia del enunciado usa Redis para el estado caliente y la difusión entre réplicas.
Microsoft bloqueó la creación de nuevas instancias de Azure Cache for Redis para clientes existentes desde el
1 de octubre de 2026 y recomienda Azure Managed Redis.

## Decisión

Usar Azure Managed Redis, SKU Balanced B0 sin alta disponibilidad, en modo no agrupado, con autenticación de
Microsoft Entra ID por identidad administrada y las claves de acceso deshabilitadas.

## Consecuencias

- Cuesta unos USD 12 al mes por instancia; dev se destruye cuando no se usa.
- Sin alta disponibilidad, un reinicio de Redis pierde el estado caliente. No se pierde nada confirmado: el
  servidor reconstruye desde Postgres (ver ADR 0002).
- El modo no agrupado evita adaptar pub/sub y los scripts Lua a un clúster.
