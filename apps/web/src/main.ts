import '@fontsource/jersey-15/400.css';
import './styles.css';

import { ApiError, ArenalApi, ReconnectingSession, RejectedError, type Room } from '@arenal/client';
import type { Card, MatchResult, PlayerView } from '@arenal/domain';
import { byId, h, prefersReducedMotion } from './dom.js';
import { startMagma } from './magma.js';
import { Table } from './table.js';

const api = new ArenalApi(window.location.origin);
const app = byId('app');
const canvas = byId('magma');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('#magma no es un canvas');
const magma = startMagma(canvas, prefersReducedMotion());

interface Me {
  readonly id: string;
  readonly name: string;
}

const state = {
  me: null as Me | null,
  link: null as ReconnectingSession | null,
  matchId: null as string | null,
  names: new Map<string, string>(),
  lastView: null as PlayerView | null,
  stopWaiting: null as (() => void) | null,
};

const who = (playerId: string): string =>
  playerId === state.me?.id ? 'Tú' : (state.names.get(playerId) ?? `Jugador ${playerId.slice(0, 4)}`);

const table = new Table({
  who,
  onHeat: (heat) => {
    magma.setHeat(heat);
  },
  onPlay: (card) => {
    void play(card);
  },
});

// --- Mensajes -----------------------------------------------------------------------------------

let toastTimer = 0;
function toast(message: string): void {
  const el = byId('toast');
  el.textContent = message;
  el.classList.add('toast--on');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.classList.remove('toast--on');
  }, 4000);
}

function problemText(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail ?? 'El servidor rechazó la solicitud.';
  if (error instanceof RejectedError) return error.message.replace(/^[A-Z_]+: /, '');
  if (error instanceof Error && error.name === 'TimeoutError') return 'El servidor tardó demasiado en responder.';
  return 'No se pudo hablar con el servidor. Revisa tu conexión e inténtalo de nuevo.';
}

// --- Conexión -------------------------------------------------------------------------------------

function setNet(status: 'on' | 'reconnecting' | 'off', text: string): void {
  const el = byId('net');
  el.dataset['status'] = status;
  el.replaceChildren(h('span', { class: 'net__dot', attrs: { 'aria-hidden': 'true' } }), text);
}

/** Versión y réplica del servidor que responde: cambian cuando se publica una revisión nueva. */
async function pollServer(): Promise<void> {
  try {
    const res = await fetch('/health/live', { signal: AbortSignal.timeout(4000) });
    const body = (await res.json()) as { version?: string; replica?: string };
    const el = byId('server');
    el.textContent = `Servidor ${body.version ?? '?'}`;
    el.title = body.replica === undefined ? '' : `Réplica ${body.replica}`;
  } catch {
    // Si falla, se queda lo último que se mostró.
  }
}

// La cuenta es temporal y vive solo en esta pestaña: al recargar se vuelve a entrar con ella y la
// partida en curso sigue (el servidor manda su estado al reconectar).
const ACCOUNT_KEY = 'arenal.cuenta';
interface Account {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

function savedAccount(): Account | null {
  try {
    const raw = sessionStorage.getItem(ACCOUNT_KEY);
    return raw === null ? null : (JSON.parse(raw) as Account);
  } catch {
    return null;
  }
}

async function signIn(name: string): Promise<Me> {
  const saved = savedAccount();
  if (saved?.name === name) {
    try {
      const session = await api.login({ email: saved.email, password: saved.password });
      return { id: session.user.id, name };
    } catch {
      // La cuenta ya no sirve (por ejemplo, se reconstruyó la base): se crea otra.
    }
  }
  const id = crypto.randomUUID();
  const account: Account = {
    email: `web-${id.slice(0, 12)}@jugadores.arenal.invalid`,
    password: `w-${crypto.randomUUID()}`,
    name,
  };
  const session = await api.register({ email: account.email, password: account.password, displayName: name });
  try {
    sessionStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  } catch {
    // Sin almacenamiento de sesión, simplemente no se recuerda al recargar.
  }
  return { id: session.user.id, name };
}

async function connect(): Promise<void> {
  if (state.link !== null) return;
  setNet('reconnecting', 'Conectando…');
  state.link = await ReconnectingSession.open(
    api,
    {
      onSnapshot: (view) => {
        showMatch(view);
      },
      onEvent: (event, _seq, view) => {
        if (view.matchId !== state.matchId) return;
        table.event(event, view);
        // Se deja ver la última erupción antes de tapar la mesa con el resultado.
        if (event.type === 'MatchEnded') {
          const { result } = event;
          window.setTimeout(() => {
            if (state.matchId === view.matchId) showEnd(result);
          }, 1800);
        }
      },
      onClose: () => {
        setNet('off', 'Sin conexión');
        state.link = null;
      },
    },
    {
      onDisconnect: () => {
        setNet('reconnecting', 'Reconectando…');
        toast('Se cortó la conexión con el servidor. Reconectando…');
      },
      onReconnect: () => {
        setNet('on', 'En línea');
        toast('Reconectado. La partida sigue donde iba.');
        void pollServer();
      },
    },
  );
  setNet('on', 'En línea');
}

// --- Pantallas ------------------------------------------------------------------------------------

function show(screen: HTMLElement, name: string): void {
  state.stopWaiting?.();
  state.stopWaiting = null;
  document.body.dataset['screen'] = name;
  byId('overlay').replaceChildren();
  app.replaceChildren(screen);
}

function showHome(error?: string): void {
  const name = h('input', {
    class: 'field__input',
    attrs: {
      id: 'name',
      name: 'name',
      required: '',
      minlength: '2',
      maxlength: '32',
      autocomplete: 'nickname',
      pattern: '[\\p{L}\\p{N} _.\\-]+',
      title: 'Solo letras, números, espacios y _ . -',
      value: state.me?.name ?? savedAccount()?.name ?? '',
    },
  });
  const code = h('input', {
    class: 'field__input field__input--code',
    attrs: {
      id: 'code',
      maxlength: '8',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'Código de la sala',
      placeholder: 'código',
    },
  });
  const message = h('p', { class: 'form-error', attrs: { role: 'alert' }, text: error ?? '' });

  const withName = (action: () => Promise<void>) => async () => {
    if (!name.reportValidity()) return;
    message.textContent = '';
    try {
      const chosen = name.value.trim();
      if (state.me?.name !== chosen) {
        state.link?.close();
        state.link = null;
        state.me = await signIn(chosen);
      }
      await connect();
      await action();
    } catch (err) {
      message.textContent = problemText(err);
    }
  };

  const form = h(
    'form',
    {
      class: 'panel home__form',
      attrs: { novalidate: '' },
      on: {
        submit: (event) => {
          event.preventDefault();
          void withName(startQueue)();
        },
      },
    },
    [
      h('label', { class: 'field__label', text: 'Tu nombre', attrs: { for: 'name' } }),
      name,
      h('button', { class: 'btn btn--lava', text: 'Buscar partida', attrs: { type: 'submit' } }),
      h('button', {
        class: 'btn btn--stone',
        text: 'Crear sala privada',
        attrs: { type: 'button' },
        on: { click: () => void withName(createRoom)() },
      }),
      h('div', { class: 'home__join' }, [
        code,
        h('button', {
          class: 'btn btn--ghost',
          text: 'Entrar con código',
          attrs: { type: 'button' },
          on: {
            click: () => {
              const value = code.value.trim().toUpperCase();
              if (value.length !== 8) {
                message.textContent = 'El código de una sala tiene 8 caracteres.';
                code.focus();
                return;
              }
              void withName(() => joinRoom(value))();
            },
          },
        }),
      ]),
      message,
    ],
  );

  const rules = h('details', { class: 'rules' }, [
    h('summary', { text: 'Cómo se juega' }),
    h('ul', {}, [
      h('li', { text: 'Por turnos, cada quien juega una carta y roba otra.' }),
      h('li', {
        text: 'Las piedras suben la presión del volcán; Enfriar la baja 3; el sismógrafo te dice, solo a ti, si el límite está cerca.',
      }),
      h('li', {
        text: 'Cada ronda el volcán tiene un límite secreto entre 15 y 25. Si tu carta hace que la presión lo pase, hay erupción y pierdes una vida.',
      }),
      h('li', { text: 'Gana quien quede en pie. Si en 30 segundos no juegas, el servidor juega por ti.' }),
    ]),
  ]);

  show(
    h('section', { class: 'home' }, [
      h('div', { class: 'home__brand' }, [
        h('h1', { class: 'logo', text: 'Arenal' }),
        h('p', {
          class: 'home__tagline',
          text: 'Echen piedras al volcán por turnos. Su límite es secreto: quien lo pase lo hace estallar.',
        }),
      ]),
      form,
      rules,
    ]),
    'home',
  );
  if (name.value === '') name.focus();
}

async function startQueue(): Promise<void> {
  await api.enqueue();
  const started = Date.now();
  const seconds = h('span', { text: '0' });
  show(
    h('section', { class: 'panel waiting' }, [
      h('h2', { class: 'waiting__title', text: 'Buscando rivales' }),
      h('p', {}, ['Llevas ', seconds, ' s en la cola. La partida empieza sola cuando haya al menos 2 jugadores.']),
      h('p', { class: 'hint' }, [
        '¿Estás solo? Abre esta página en otra pestaña, o trae bots desde la terminal (en la carpeta del proyecto):',
        h('code', { class: 'command', text: `pnpm bot --url ${window.location.origin} --bots 3 --games 5` }),
      ]),
      h('button', {
        class: 'btn btn--ghost',
        text: 'Cancelar',
        attrs: { type: 'button' },
        on: {
          click: () => {
            void api.leaveQueue().finally(() => {
              showHome();
            });
          },
        },
      }),
    ]),
    'queue',
  );
  // La cola guarda el lugar un rato; si vence sin partida, se vuelve a entrar sola.
  const tick = window.setInterval(() => {
    seconds.textContent = String(Math.floor((Date.now() - started) / 1000));
  }, 1000);
  const poll = window.setInterval(() => {
    void api
      .ticketStatus()
      .then((ticket) => (ticket.state === 'expired' || ticket.state === 'idle' ? api.enqueue() : ticket))
      .catch(() => undefined);
  }, 3000);
  state.stopWaiting = () => {
    window.clearInterval(tick);
    window.clearInterval(poll);
  };
}

async function createRoom(): Promise<void> {
  showRoom(await api.createRoom({ visibility: 'private', capacity: 4 }));
}

async function joinRoom(code: string): Promise<void> {
  showRoom(await api.joinByCode(code));
}

function showRoom(initial: Room): void {
  let room = initial;
  const members = h('ul', { class: 'members' });
  const readyButton = h('button', { class: 'btn btn--lava', attrs: { type: 'button' } });
  const code = room.inviteCode ?? '';

  const render = (): void => {
    const mine = room.members?.find((m) => m.userId === state.me?.id);
    readyButton.textContent = mine?.ready === true ? 'Ya no estoy listo' : 'Estoy listo';
    members.replaceChildren(
      ...(room.members ?? []).map((m) =>
        h('li', { class: `member${m.ready ? ' member--ready' : ''}` }, [
          h('span', {
            class: 'member__name',
            text: m.userId === state.me?.id ? `${m.displayName} (tú)` : m.displayName,
          }),
          h('span', { class: 'member__state', text: m.ready ? 'Listo' : 'Esperando' }),
        ]),
      ),
    );
  };
  readyButton.addEventListener('click', () => {
    const mine = room.members?.find((m) => m.userId === state.me?.id);
    void api
      .setReady(room.id, mine?.ready !== true)
      .then((updated) => {
        room = updated;
        render();
      })
      .catch((err: unknown) => {
        toast(problemText(err));
      });
  });

  show(
    h('section', { class: 'panel waiting' }, [
      h('h2', { class: 'waiting__title', text: 'Sala privada' }),
      h('p', { text: 'Comparte este código para que entren a tu sala:' }),
      h('div', { class: 'invite' }, [
        h('output', { class: 'invite__code', text: code }),
        h('button', {
          class: 'btn btn--ghost',
          text: 'Copiar',
          attrs: { type: 'button' },
          on: {
            click: () => {
              void navigator.clipboard.writeText(code).then(
                () => {
                  toast('Código copiado.');
                },
                () => {
                  toast(`El código es ${code}.`);
                },
              );
            },
          },
        }),
      ]),
      members,
      h('p', { class: 'hint', text: 'La partida empieza cuando todos marcan «Estoy listo» (mínimo 2 jugadores).' }),
      h('div', { class: 'waiting__actions' }, [
        readyButton,
        h('button', {
          class: 'btn btn--ghost',
          text: 'Salir de la sala',
          attrs: { type: 'button' },
          on: {
            click: () => {
              void api.leaveRoom(room.id).finally(() => {
                showHome();
              });
            },
          },
        }),
      ]),
    ]),
    'room',
  );
  render();
  const poll = window.setInterval(() => {
    void api
      .getRoom(room.id)
      .then((updated) => {
        room = updated;
        render();
      })
      .catch(() => undefined);
  }, 2000);
  state.stopWaiting = () => {
    window.clearInterval(poll);
  };
}

/** Nombres de los jugadores de la partida (el estado de la partida solo trae sus IDs). */
async function loadNames(matchId: string): Promise<void> {
  try {
    const matches = await api.myMatches(5);
    const match = matches.find((m) => m.matchId === matchId);
    for (const p of match?.players ?? []) state.names.set(p.id, p.displayName);
    if (state.matchId === matchId && state.lastView !== null) table.load(state.lastView, state.me?.id ?? '', false);
  } catch {
    // Sin nombres se muestran los IDs cortos.
  }
}

function showMatch(view: PlayerView): void {
  const fresh = view.matchId !== state.matchId;
  state.lastView = view;
  if (fresh) {
    state.matchId = view.matchId;
    void loadNames(view.matchId);
  }
  if (document.body.dataset['screen'] !== 'table') show(table.el, 'table');
  table.load(view, state.me?.id ?? '', fresh);
  if (view.status === 'finished' && view.result !== null) showEnd(view.result);
}

function showEnd(result: MatchResult): void {
  const myId = state.me?.id;
  let title: string;
  let detail: string;
  if (result.kind === 'winner') {
    title = result.winner === myId ? 'Ganaste' : `Ganó ${who(result.winner)}`;
    detail = result.winner === myId ? 'Fuiste el último en pie.' : 'El volcán no tuvo piedad esta vez.';
  } else if (result.kind === 'draw') {
    title = 'Empate';
    detail = `Terminaron empatados: ${result.players.map(who).join(', ')}.`;
  } else {
    title = 'Partida cancelada';
    detail = 'Un administrador terminó la partida.';
  }
  const again = h('button', {
    class: 'btn btn--lava',
    text: 'Buscar otra partida',
    attrs: { type: 'button' },
    on: {
      click: () => {
        void startQueue().catch((err: unknown) => {
          toast(problemText(err));
        });
      },
    },
  });
  byId('overlay').replaceChildren(
    h('div', { class: 'overlay', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'end-title' } }, [
      h('div', { class: `panel end end--${result.kind === 'winner' && result.winner === myId ? 'win' : 'lose'}` }, [
        h('h2', { class: 'end__title', text: title, attrs: { id: 'end-title' } }),
        h('p', { class: 'end__detail', text: detail }),
        h('div', { class: 'end__actions' }, [
          again,
          h('button', {
            class: 'btn btn--ghost',
            text: 'Ver la mesa',
            attrs: { type: 'button' },
            on: {
              click: () => {
                byId('overlay').replaceChildren();
              },
            },
          }),
          h('button', {
            class: 'btn btn--ghost',
            text: 'Volver al inicio',
            attrs: { type: 'button' },
            on: {
              click: () => {
                showHome();
              },
            },
          }),
        ]),
      ]),
    ]),
  );
  again.focus();
}

async function play(card: Card): Promise<void> {
  const link = state.link;
  if (link === null) return;
  table.setPending(true);
  try {
    await link.current.playCard(card.id);
  } catch (err) {
    // STALE_STATE: llegó un evento justo antes; la vista ya se actualizó y se puede volver a elegir.
    if (!(err instanceof RejectedError && err.code === 'STALE_STATE')) toast(problemText(err));
  } finally {
    table.setPending(false);
  }
}

document.addEventListener('keydown', (event) => {
  if (document.body.dataset['screen'] !== 'table' || event.target instanceof HTMLInputElement) return;
  const n = Number(event.key);
  if (Number.isInteger(n) && n >= 1 && n <= 9) table.playAt(n - 1);
});

// --- Arranque -----------------------------------------------------------------------------------

void pollServer();
window.setInterval(() => void pollServer(), 5000);
setNet('off', 'Sin conectar');
showHome();

// Si esta pestaña ya tenía cuenta (por ejemplo, se recargó a mitad de partida), se reconecta sola:
// el servidor manda el estado de la partida en curso.
const saved = savedAccount();
if (saved !== null) {
  void signIn(saved.name)
    .then(async (me) => {
      state.me = me;
      await connect();
    })
    .catch(() => {
      setNet('off', 'Sin conectar');
    });
}
