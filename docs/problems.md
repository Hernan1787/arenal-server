# Catálogo de errores HTTP (Problem Details)

Todas las respuestas de error de la API usan `application/problem+json` (RFC 9457). El campo `type` es una
referencia relativa a esta lista. Ningún error incluye detalles internos (trazas, consultas, nombres de host)
ni repite los valores que mandó el cliente.

| `type`                        | Estado | Cuándo                                                                                                                   |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `/problems/validation-error`  | 400    | El cuerpo, los parámetros o la query no cumplen el esquema. `detail` dice qué campo y qué regla.                         |
| `/problems/unauthorized`      | 401    | Falta el token, no es válido o venció; también credenciales o refresh token inválidos. Trae `WWW-Authenticate: Bearer`.  |
| `/problems/forbidden`         | 403    | Autenticado, pero sin permiso.                                                                                           |
| `/problems/not-found`         | 404    | La ruta o el recurso no existe. Una sala privada o una partida ajena también responden 404, para no revelar que existen. |
| `/problems/conflict`          | 409    | La operación choca con el estado actual; ver `code`.                                                                     |
| `/problems/payload-too-large` | 413    | El cuerpo pasa de 16 KB.                                                                                                 |
| `/problems/rate-limited`      | 429    | Demasiadas solicitudes; viene con `Retry-After`.                                                                         |
| `/problems/not-ready`         | 503    | `/health/ready`: alguna dependencia no responde o la réplica está drenando. Trae `checks`.                               |
| `/problems/internal`          | 500    | Error no controlado. El detalle queda solo en los logs.                                                                  |

## Códigos (`code`)

Cuando un mismo estado HTTP puede tener varias causas, el problema trae un `code` estable:

| `code`              | Estado | Significado                                                   |
| ------------------- | ------ | ------------------------------------------------------------- |
| `EMAIL_TAKEN`       | 409    | Ya existe una cuenta con ese correo.                          |
| `ACCOUNT_SUSPENDED` | 403    | La cuenta está suspendida.                                    |
| `ALREADY_IN_ROOM`   | 409    | El usuario ya está en una sala.                               |
| `ALREADY_QUEUED`    | 409    | El usuario ya está en la cola de emparejamiento.              |
| `ALREADY_IN_MATCH`  | 409    | El usuario ya está jugando una partida.                       |
| `ROOM_FULL`         | 409    | La sala llegó a su capacidad.                                 |
| `ROOM_NOT_OPEN`     | 409    | La sala ya arrancó o se cerró.                                |
| `MATCH_IN_PROGRESS` | 409    | La repetición solo está disponible cuando la partida termina. |

Ejemplo:

```json
{
  "type": "/problems/conflict",
  "title": "Conflicto con el estado actual",
  "status": 409,
  "detail": "La sala está llena",
  "instance": "/v1/rooms/0193f2a1-7c4e-7b1a-9d2e-5f6a7b8c9d0e/join",
  "code": "ROOM_FULL"
}
```

Los errores del canal en tiempo real no usan Problem Details: son mensajes `error` con un `code` tipado,
documentados en `packages/contracts/generated/asyncapi.yaml`.
