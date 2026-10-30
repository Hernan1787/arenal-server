/**
 * Punto de entrada de la telemetría: `node --import ./dist/instrument.js dist/main.js`. Corre
 * antes de que se cargue el servidor, así las instrumentaciones envuelven http, pg y redis.
 * Si falla, el servidor arranca igual, sin telemetría.
 */
try {
  const { startTelemetry } = await import('./observability/telemetry.js');
  await startTelemetry();
} catch (err) {
  process.stderr.write(`Telemetría desactivada: ${err instanceof Error ? err.message : String(err)}\n`);
}
