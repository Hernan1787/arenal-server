# 0006 — Autenticación propia con JWT ES256 y refresh rotativo

- Estado: aceptada
- Fecha: 29 de octubre de 2026

## Contexto

El enunciado acepta un proveedor OIDC externo o JWT emitidos por el propio servidor con contraseñas en
Argon2id o bcrypt. Un proveedor externo agrega configuración, costo y una dependencia más en la demo.

## Decisión

- **Contraseñas:** Argon2id con los parámetros mínimos de OWASP (19 MiB, 2 iteraciones, 1 hilo). Si el correo
  no existe, igual se verifica contra un hash de relleno para que el tiempo no revele qué cuentas existen.
- **Access token:** JWT ES256 de 10 minutos con `iss`, `aud`, `sub` y `role`. La llave privada es el único
  secreto del sistema: en Azure llega desde Key Vault por la identidad administrada.
- **Refresh token:** 32 bytes aleatorios, opacos, de un solo uso. En la base se guarda solo su SHA-256. Cada
  renovación marca el usado y entrega uno nuevo de la misma familia. Si llega uno ya usado, se revoca la
  familia completa (detección de robo). Cerrar sesión también revoca la familia.
- **Suspensión inmediata:** la guardia de autenticación consulta la cuenta en cada solicitud, así una
  suspensión aplica sin esperar a que venza el token.
- **Límites:** registro, login y unión por código tienen límite por IP con 429 y `Retry-After`.

## Consecuencias

- La demo no depende de un proveedor externo.
- Cada solicitud autenticada hace una consulta por clave primaria a `users`; es barata y da suspensión al
  instante.
- Por ahora el límite de tasa vive en la memoria de cada réplica. El bloque de seguridad lo pasa a Redis para
  que sea compartido entre réplicas.
