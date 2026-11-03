# 0012 — Interfaz web servida por el mismo servidor

- Estado: aceptada
- Fecha: 3 de noviembre de 2026

## Contexto

El enunciado no califica el cliente («el juego en sí (reglas, gráficos, diversión y cliente) no tiene nota»), pero
quien revise la URL pública solo veía la documentación de la API, y el cliente de terminal pide clonar el repo. Se
quiso una interfaz en el navegador, con una estética propia (pixel art de volcán, en la línea de los juegos de
cartas como Balatro), sin agregar servicios a Azure ni complicar la seguridad.

## Decisión

- **La sirve el mismo servidor** con `@fastify/static` en la raíz (`WEB_ROOT`; en la imagen, `/app/web`). Mismo
  origen que la API y el WebSocket: no hace falta CORS ni otro recurso de Azure, y cada despliegue publica el
  servidor y la web juntos, con la misma revisión y el mismo rollback.
- **Vite + TypeScript, sin framework** (`apps/web`). La página es una mesa con pocos elementos; el DOM se arma con
  un ayudante que solo usa `textContent`, así ningún dato del servidor se interpreta como HTML.
- **El mismo cliente que el bot.** `@arenal/client` tiene dos entradas: la de Node usa la librería `ws` y la de
  navegador el WebSocket nativo (condición `browser` en `exports`). La web reutiliza la validación de mensajes, la
  vista con `applyPlayerEvent`, la reconexión automática y los textos de los eventos.
- **CSP por ruta.** La API sigue con `default-src 'none'`. Las rutas de la web permiten solo archivos propios
  (`script-src`, `style-src`, `font-src` e `img-src` en `'self'`) y el WebSocket al mismo host. La fuente (Jersey
  15, licencia OFL) va empaquetada, sin pedir nada a otros dominios.
- **Cuenta temporal por pestaña.** Al jugar se registra un usuario con correo y contraseña al azar, guardados en
  `sessionStorage` para que recargar a mitad de partida reconecte. Riesgo aceptado en el modelo de amenazas.

## Alternativas descartadas

- **Azure Static Web Apps:** otro recurso, otro origen (CORS y orígenes de WebSocket que mantener) y regiones
  limitadas en la suscripción de estudiante.
- **React u otro framework:** más dependencias y más superficie para una página de una sola pantalla de juego.

## Consecuencias

- La imagen crece unos 200 KB (JS, CSS y la fuente).
- Las pantallas de la web no tienen pruebas automáticas propias; lo que comparten con el bot (cliente, textos) sí
  las tiene, y una partida completa entre dos navegadores se probó con Playwright antes de publicarla.
- El fondo de magma usa WebGL; sin WebGL, o con «reducir movimiento», queda un fondo fijo.
