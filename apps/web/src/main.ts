import '@fontsource/jersey-15/400.css';
import './styles.css';

import { ApiError, ArenalApi, cardHelp, cardName, ReconnectingSession, RejectedError, type Room } from '@arenal/client';
import {
  DEFAULT_CONFIG,
  type Card,
  type CardFace,
  type MatchResult,
  type PlayerView,
  type PublicRules,
} from '@arenal/domain';
import { cardFace } from './cards.js';
import { byId, h, prefersReducedMotion } from './dom.js';
import { startMagma } from './magma.js';
import { MAX_BOTS, Practice } from './practice.js';
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
  /** Cuántos bots tenía la última partida de práctica (0 si fue contra personas). */
  practiceBots: 0,
};

const practice = new Practice(window.location.origin);
const BOTS_PREF_KEY = 'arenal.bots-por-partida';

function preferredBots(): number {
  try {
    const n = Number(localStorage.getItem(BOTS_PREF_KEY));
    return Number.isInteger(n) && n >= 1 && n <= MAX_BOTS ? n : 2;
  } catch {
    return 2;
  }
}

const who = (playerId: string): string =>
  playerId === state.me?.id ? 'Tú' : (state.names.get(playerId) ?? `Jugador ${playerId.slice(0, 4)}`);

const table = new Table({
  who,
  onHeat: (heat) => {
    magma.setHeat(heat);
  },
  onPlay: (card, targetId) => {
    void play(card, targetId);
  },
  onEnd: (result) => {
    const matchId = state.matchId;
    // Se deja ver la última erupción antes de tapar la mesa con el resultado.
    window.setTimeout(() => {
      if (state.matchId === matchId) showEnd(result);
    }, 1500);
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
        table.push(event, view);
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
  let bots = preferredBots();
  const botChoice = h(
    'div',
    { class: 'bots', attrs: { role: 'radiogroup', 'aria-label': 'Cuántos bots' } },
    Array.from({ length: MAX_BOTS }, (_, i) => {
      const n = i + 1;
      const option = h('button', {
        class: 'bots__option',
        text: String(n),
        attrs: { type: 'button', role: 'radio', 'aria-checked': String(n === bots), 'aria-label': `${n} bots` },
        on: {
          click: () => {
            bots = n;
            for (const el of botChoice.querySelectorAll('.bots__option')) {
              el.setAttribute('aria-checked', String(el === option));
            }
            try {
              localStorage.setItem(BOTS_PREF_KEY, String(n));
            } catch {
              // No se recuerda la elección; no pasa nada.
            }
          },
        },
      });
      return option;
    }),
  );

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
          void withName(() => startPractice(bots))();
        },
      },
    },
    [
      h('label', { class: 'field__label', text: 'Tu nombre', attrs: { for: 'name' } }),
      name,
      h('div', { class: 'home__practice' }, [
        h('button', { class: 'btn btn--lava', text: 'Jugar contra bots', attrs: { type: 'submit' } }),
        h('div', { class: 'bots__wrap' }, [h('span', { class: 'bots__label', text: 'Bots' }), botChoice]),
      ]),
      h('button', {
        class: 'btn btn--stone',
        text: 'Buscar partida con personas',
        attrs: { type: 'button' },
        on: { click: () => void withName(startQueue)() },
      }),
      h('button', {
        class: 'btn btn--ghost',
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

  const c = DEFAULT_CONFIG;
  const rules = h('details', { class: 'rules' }, [
    h('summary', { text: 'Cómo se juega' }),
    h('ul', {}, [
      h('li', { text: 'Por turnos, cada quien juega una carta y roba otra.' }),
      h('li', {
        text: `Cada ronda el volcán tiene un límite secreto entre ${c.limitMin} y ${c.limitMax}. Si tu carta hace que la presión lo pase, hay erupción y pierdes una vida.`,
      }),
      h('li', {
        text: `Empiezas con ${c.startingLives} vidas. Gana quien quede en pie. Si en 30 segundos no juegas, el servidor juega por ti.`,
      }),
    ]),
    h('h3', { class: 'rules__title', text: 'Las cartas' }),
    h(
      'ul',
      { class: 'deck-list' },
      deckSample().map(({ card, count }) => cardRow(card, count, publicRules())),
    ),
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

/** Una carta de cada tipo, con cuántas hay en el mazo. */
function deckSample(): { card: CardFace; count: number }[] {
  const d = DEFAULT_CONFIG.deck;
  return [
    { card: { kind: 'stone', value: 3 }, count: d.stones[1] + d.stones[2] + d.stones[3] + d.stones[4] },
    { card: { kind: 'bomb' }, count: d.bomb },
    { card: { kind: 'quake' }, count: d.quake },
    { card: { kind: 'cool' }, count: d.cool },
    { card: { kind: 'rain' }, count: d.rain },
    { card: { kind: 'seismo' }, count: d.seismo },
    { card: { kind: 'divert' }, count: d.divert },
    { card: { kind: 'ash' }, count: d.ash },
    { card: { kind: 'steal' }, count: d.steal },
    { card: { kind: 'shield' }, count: d.shield },
  ];
}

function publicRules(): PublicRules {
  const c = DEFAULT_CONFIG;
  return {
    startingLives: c.startingLives,
    handSize: c.handSize,
    limitMin: c.limitMin,
    limitMax: c.limitMax,
    coolAmount: c.coolAmount,
    rainAmount: c.rainAmount,
    bombAmount: c.bombAmount,
    quakeMin: c.quakeMin,
    quakeMax: c.quakeMax,
    seismoThreshold: c.seismoThreshold,
    maxRounds: c.maxRounds,
  };
}

function cardRow(card: CardFace, count: number, rules: PublicRules): HTMLLIElement {
  const help = card.kind === 'stone' ? 'Suben la presión de 1 a 4.' : cardHelp(card, rules);
  return h('li', { class: 'deck-list__item' }, [
    cardFace(card, rules, 'card--mini'),
    h('span', { class: 'deck-list__text' }, [
      h('span', { class: 'deck-list__name', text: card.kind === 'stone' ? 'Piedras' : cardName(card) }),
      h('span', { class: 'deck-list__help', text: `${help} Hay ${count}.` }),
    ]),
  ]);
}

async function startPractice(bots: number): Promise<void> {
  const host = h('section', { class: 'panel waiting' }, [
    h('h2', { class: 'waiting__title', text: 'Llamando a los bots' }),
    h('p', { text: `Se arma una sala privada con ${bots} ${bots === 1 ? 'bot' : 'bots'}; la partida empieza sola.` }),
  ]);
  show(host, 'queue');
  state.practiceBots = bots;
  await practice.start(api, bots);
}

async function startQueue(): Promise<void> {
  state.practiceBots = 0;
  await api.enqueue();
  const started = Date.now();
  const seconds = h('span', { text: '0' });
  show(
    h('section', { class: 'panel waiting' }, [
      h('h2', { class: 'waiting__title', text: 'Buscando rivales' }),
      h('p', {}, ['Llevas ', seconds, ' s en la cola. La partida empieza sola cuando haya al menos 2 jugadores.']),
      h('p', { class: 'hint' }, [
        '¿Nadie más en línea? Cancela y elige «Jugar contra bots», o abre esta página en otra pestaña. También puedes traer bots desde la terminal (en la carpeta del proyecto):',
        h('code', { class: 'command', text: `pnpm bot --url ${window.location.origin} --bots 2 --games 5` }),
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
  const bots = state.practiceBots;
  const again = h('button', {
    class: 'btn btn--lava',
    text: bots > 0 ? 'Jugar otra vez' : 'Buscar otra partida',
    attrs: { type: 'button' },
    on: {
      click: () => {
        void (bots > 0 ? startPractice(bots) : startQueue()).catch((err: unknown) => {
          toast(problemText(err));
          showHome();
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

async function play(card: Card, targetId?: string): Promise<void> {
  const link = state.link;
  if (link === null) return;
  table.setPending(true);
  try {
    await link.current.playCard(card.id, targetId);
  } catch (err) {
    // STALE_STATE: llegó un evento justo antes; la vista ya se actualizó y se puede volver a elegir.
    if (!(err instanceof RejectedError && err.code === 'STALE_STATE')) toast(problemText(err));
  } finally {
    table.setPending(false);
  }
}

document.addEventListener('keydown', (event) => {
  if (document.body.dataset['screen'] !== 'table' || event.target instanceof HTMLInputElement) return;
  if (event.key === 'Escape') {
    table.cancel();
    return;
  }
  const n = Number(event.key);
  if (Number.isInteger(n) && n >= 1 && n <= 9) table.key(n - 1);
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
      // Si había bots de práctica, vuelven a la partida en curso.
      if (Practice.hasSaved()) await practice.resume();
    })
    .catch(() => {
      setNet('off', 'Sin conectar');
    });
}
