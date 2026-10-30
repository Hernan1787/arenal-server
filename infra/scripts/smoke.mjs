// Prueba de humo contra una URL desplegada. Recorre el camino completo con las dependencias
// reales: Postgres (registro), Key Vault (firma del JWT), Redis (ticket) y el WebSocket.
// Uso: node infra/scripts/smoke.mjs https://ca-arenal-dev.<dominio>
import { randomUUID } from 'node:crypto';

const base = process.argv[2]?.replace(/\/$/, '');
if (!base?.startsWith('https://') && !base?.startsWith('http://')) {
  console.error('Uso: node smoke.mjs <url>');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    console.log(`  ok  ${name} (${Date.now() - started} ms)${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    console.error(`  X   ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

async function json(path, init) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

console.log(`Prueba de humo: ${base}`);

// Una revisión recién creada tarda en arrancar y migrar: se espera hasta 3 minutos.
await step('/health/ready', async () => {
  const deadline = Date.now() + 180_000;
  let last = 'sin respuesta';
  while (Date.now() < deadline) {
    try {
      const { status, body } = await json('/health/ready');
      if (status === 200) return JSON.stringify(body.checks);
      last = `${status} ${JSON.stringify(body)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(5_000);
  }
  throw new Error(`no quedó lista: ${last}`);
});

await step('OpenAPI publicado en /docs', async () => {
  const { status, body } = await json('/docs/json');
  if (status !== 200 || body?.openapi !== '3.1.0') throw new Error(`respuesta ${status}`);
  return `versión ${body.info.version}`;
});

let accessToken = '';
await step('registro (Postgres + firma del JWT con la llave de Key Vault)', async () => {
  const { status, body } = await json('/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `humo-${randomUUID()}@humo.arenal.invalid`,
      // Aleatoria en cada corrida: no queda ninguna contraseña escrita.
      password: `h-${randomUUID()}`,
      displayName: 'Prueba de humo',
    }),
  });
  if (status !== 201) throw new Error(`respuesta ${status}: ${JSON.stringify(body)}`);
  accessToken = body.accessToken;
});

let ticket = '';
await step('ticket de WebSocket (Redis)', async () => {
  const { status, body } = await json('/v1/realtime/tickets', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (status !== 201) throw new Error(`respuesta ${status}: ${JSON.stringify(body)}`);
  ticket = body.ticket;
});

await step('WebSocket con el ticket (handshake y suscripción en Redis)', async () => {
  const url = `${base.replace(/^http/, 'ws')}/v1/realtime?ticket=${encodeURIComponent(ticket)}`;
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('no abrió en 15 s'));
    }, 15_000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      ws.close(1000);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('el handshake falló'));
    });
  });
});

console.log('Prueba de humo superada');
