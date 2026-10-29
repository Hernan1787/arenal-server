# 0001 — TypeScript sobre Node 24

- Estado: aceptada
- Fecha: 29 de octubre de 2026

## Contexto

El enunciado pide un lenguaje con tipado estático y modo estricto. Entre las opciones está TypeScript sobre
Node 20 o superior. El equipo ya trabajó con Node y Express en el curso. Node 20 dejó de recibir parches el
30 de abril de 2026.

## Decisión

TypeScript 6.0 en modo estricto sobre Node 24 LTS (soporte hasta abril de 2028). Además de `strict`, se activan
`noUncheckedIndexedAccess` y `exactOptionalPropertyTypes`, y ESLint con `strictTypeChecked` prohíbe `any`.

Se usa TypeScript 6.0 y no 7.0 porque typescript-eslint todavía no soporta la versión 7.

## Consecuencias

- El equipo no pierde tiempo aprendiendo otro lenguaje.
- Node es de un solo hilo: el trabajo por jugada debe ser corto. El motor de reglas es O(cartas en juego), así
  que no es un problema; la prueba de carga lo va a confirmar.
- El escaneo de seguridad no marca el runtime como fuera de soporte.
