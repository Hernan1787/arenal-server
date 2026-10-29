# Catálogo de errores HTTP (Problem Details)

Todas las respuestas de error de la API usan `application/problem+json` (RFC 9457). El campo `type` es una
referencia relativa a esta lista. Ningún error incluye detalles internos (trazas, consultas, nombres de host).

| `type` | Estado | Cuándo |
| --- | --- | --- |
| `/problems/validation-error` | 400 | El cuerpo, los parámetros o la query no cumplen el esquema. |
| `/problems/unauthorized` | 401 | Falta el token o no es válido. |
| `/problems/forbidden` | 403 | Autenticado, pero sin permiso (por ejemplo, no participas en esa partida). |
| `/problems/not-found` | 404 | La ruta o el recurso no existe. |
| `/problems/conflict` | 409 | La operación choca con el estado actual (sala llena, ya estás en otra partida). |
| `/problems/payload-too-large` | 413 | El cuerpo pasa de 16 KB. |
| `/problems/rate-limited` | 429 | Demasiadas solicitudes; viene con `Retry-After`. |
| `/problems/not-ready` | 503 | `/health/ready`: alguna dependencia no responde o la réplica está drenando. Trae `checks`. |
| `/problems/internal` | 500 | Error no controlado. El detalle queda solo en los logs. |

Ejemplo:

```json
{
  "type": "/problems/not-ready",
  "title": "El servicio no está listo",
  "status": 503,
  "checks": { "postgres": "ok", "redis": "fail" }
}
```

Los errores del canal en tiempo real no usan Problem Details: son mensajes `error` con un `code` tipado,
documentados en `packages/contracts/generated/asyncapi.yaml`.
