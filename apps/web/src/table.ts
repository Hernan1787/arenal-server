import { cardName, describeEvent, isPlayable, validTargets } from '@arenal/client';
import {
  needsTarget,
  type Card,
  type CardFace,
  type MatchResult,
  type PlayerEvent,
  type PlayerView,
  type PublicPlayer,
} from '@arenal/domain';
import { cardBack, cardButton, cardFace } from './cards.js';
import { h, heart, prefersReducedMotion, replay, svg } from './dom.js';
import {
  ashCloud,
  eruptionRocks,
  flash,
  floatText,
  fly,
  rainOver,
  rectOf,
  seismoLine,
  shieldBreak,
  splash,
  steam,
  type Point,
} from './fx.js';
import { createVolcano, ERUPTION_MS } from './volcano.js';

/** El servidor juega por el jugador cuando se le vence el turno (TURN_TIMEOUT_MS, 30 s por defecto). */
const TURN_MS = 30_000;
/** Lo que tarda una carta en volar hasta el cráter. */
const FLIGHT_MS = 480;

export interface TableDeps {
  readonly who: (playerId: string) => string;
  readonly onPlay: (card: Card, targetId?: string) => void;
  readonly onHeat: (heat: number) => void;
  /** Se llama cuando la mesa ya mostró el fin de la partida (después de la última erupción). */
  readonly onEnd: (result: MatchResult) => void;
}

interface Queued {
  readonly event: PlayerEvent;
  readonly view: PlayerView;
  /** Cuándo llegó: el temporizador del turno cuenta desde ahí, no desde que se mostró. */
  readonly at: number;
}

const shieldIcon = (label: string): SVGSVGElement =>
  svg('svg', { viewBox: '0 0 12 13', class: 'shield-badge', role: 'img', 'aria-label': label }, [
    svg('path', { d: 'M6 0 L12 2 V7 C12 10 9 12 6 13 C3 12 0 10 0 7 V2 Z', 'shape-rendering': 'crispEdges' }),
  ]);

/**
 * La mesa de juego: rivales, volcán, información de la ronda, registro y la mano propia.
 *
 * Los eventos no se dibujan apenas llegan: entran a una cola y cada uno se muestra el tiempo
 * suficiente para verlo (una carta volando al cráter, la erupción completa). Así, aunque los
 * demás jueguen rápido, cada jugada se alcanza a seguir. La vista que se muestra es la del
 * evento que se está mostrando; la mano solo se habilita cuando la cola llega a tu turno.
 */
export class Table {
  readonly el: HTMLElement;
  private readonly rivals = h('ul', { class: 'rivals', attrs: { 'aria-label': 'Rivales' } });
  private readonly info = h('dl', { class: 'info' });
  private readonly banner = h('p', { class: 'turn', attrs: { role: 'status' } });
  private readonly timer = h('div', { class: 'timer', attrs: { 'aria-hidden': 'true' } }, [
    h('div', { class: 'timer__bar' }),
  ]);
  private readonly pressure = h('p', { class: 'pressure__value', attrs: { 'aria-live': 'polite' } });
  private readonly played = h('div', { class: 'stage__played' });
  private readonly callout = h('div', { class: 'callout', attrs: { 'aria-hidden': 'true' } });
  private readonly volcano = createVolcano();
  private readonly stage: HTMLElement;
  private readonly log = h('ol', { class: 'log__list', attrs: { 'aria-live': 'polite' } });
  private readonly me = h('div', { class: 'me' });
  private readonly hand = h('div', { class: 'hand', attrs: { role: 'group', 'aria-label': 'Tu mano' } });
  private view: PlayerView | null = null;
  private myId = '';
  private pending = false;
  /** Carta de Ceniza o Robo esperando a que se elija contra quién. */
  private choosing: Card | null = null;
  /** Jugador que está en la segunda carta de un Desvío. */
  private secondPlay: string | null = null;
  private queue: Queued[] = [];
  private queueTimer = 0;
  private stageTimer = 0;

  constructor(private readonly deps: TableDeps) {
    this.stage = h('div', { class: 'stage' }, [
      this.banner,
      this.timer,
      h('div', { class: 'pressure' }, [this.pressure, h('span', { class: 'pressure__label', text: 'de presión' })]),
      this.volcano.el,
      this.played,
      this.callout,
    ]);
    this.el = h('section', { class: 'table', attrs: { 'aria-label': 'Mesa de juego' } }, [
      h('header', { class: 'table__rivals' }, [this.rivals]),
      h('aside', { class: 'panel table__info', attrs: { 'aria-label': 'La ronda' } }, [this.info]),
      this.stage,
      h('aside', { class: 'panel log', attrs: { 'aria-label': 'Lo que pasó' } }, [
        h('h2', { class: 'panel__title', text: 'Lo que pasó' }),
        this.log,
      ]),
      h('footer', { class: 'table__hand' }, [this.me, this.hand]),
    ]);
  }

  /** Estado completo (al conectar o al reconectar): se descarta la cola y se redibuja todo, sin efectos. */
  load(view: PlayerView, myId: string, fresh: boolean): void {
    this.queue = [];
    window.clearTimeout(this.queueTimer);
    window.clearTimeout(this.stageTimer);
    this.queueTimer = 0;
    this.myId = myId;
    this.view = view;
    this.choosing = null;
    if (fresh) {
      this.log.replaceChildren();
      this.played.replaceChildren();
      this.timer.classList.remove('timer--running');
      this.secondPlay = null;
    }
    this.render();
  }

  /** Un evento nuevo: entra a la cola de lo que hay que mostrar. */
  push(event: PlayerEvent, view: PlayerView): void {
    this.queue.push({ event, view, at: performance.now() });
    if (this.queueTimer === 0) this.pump();
  }

  /** Mientras una jugada espera respuesta del servidor, la mano no acepta otra. */
  setPending(pending: boolean): void {
    this.pending = pending;
    this.renderHand();
  }

  /** Tecla 1 a 9: juega esa carta, o elige ese rival si se está eligiendo a quién. */
  key(index: number): void {
    const view = this.view;
    if (view === null) return;
    if (this.choosing !== null) {
      const target = validTargets(view)[index];
      if (target !== undefined) this.pick(target);
      return;
    }
    const card = view.you?.hand[index];
    if (card !== undefined) this.select(card);
  }

  /** Esc: deja de elegir rival. */
  cancel(): void {
    if (this.choosing === null) return;
    this.choosing = null;
    this.render();
  }

  // --- La cola -----------------------------------------------------------------------------------

  private pump(): void {
    for (;;) {
      const item = this.queue.shift();
      if (item === undefined) {
        this.queueTimer = 0;
        return;
      }
      const wait = this.show(item);
      if (wait > 0) {
        this.queueTimer = window.setTimeout(() => {
          this.pump();
        }, wait);
        return;
      }
    }
  }

  /** Muestra un evento y devuelve cuánto esperar antes del siguiente. */
  private show({ event, view, at }: Queued): number {
    const before = this.view;
    const pace = prefersReducedMotion() ? 0.3 : 1;
    // Las posiciones de origen se leen antes de redibujar (la carta propia desaparece de la mano).
    const sourceRect =
      event.type === 'CardPlayed'
        ? rectOf(
            event.playerId === this.myId
              ? this.hand.querySelector(`[data-card="${event.card.id}"]`)
              : this.playerEl(event.playerId),
          )
        : null;

    this.view = view;
    if (this.choosing !== null && !this.canPlay()) this.choosing = null;
    const line = describeEvent(event, this.myId, this.deps.who);
    if (line !== null) this.addLog(line, event.type);

    let wait = 0;
    let deferStage = false;
    switch (event.type) {
      case 'CardPlayed': {
        const mine = event.playerId === this.myId;
        deferStage = !prefersReducedMotion();
        this.throwCard(event, view, before?.pressure ?? 0, sourceRect);
        wait = (mine ? 750 : 1150) * pace;
        break;
      }
      case 'TurnStarted': {
        this.secondPlay = before?.currentPlayer === event.playerId && before.playsLeft === 2 ? event.playerId : null;
        const left = Math.max(1000, TURN_MS - (performance.now() - at));
        this.timer.style.setProperty('--turn-ms', `${left.toFixed(0)}ms`);
        replay(this.timer, 'timer--running');
        if (event.playerId === this.myId) replay(this.hand, 'hand--wake');
        break;
      }
      case 'Eruption':
        this.timer.classList.remove('timer--running');
        this.erupt(event.playerId, event.limit, event.shielded === true);
        wait = (ERUPTION_MS + 300) * pace;
        break;
      case 'RoundStarted':
        if (event.round > 1) {
          this.showCallout(`Ronda ${event.round}`, 'Límite nuevo, secreto', 'callout--round');
          wait = 1100 * pace;
        }
        this.played.replaceChildren();
        break;
      case 'SeismoRead':
        if (event.playerId === this.myId && event.near !== undefined) {
          this.showCallout(
            event.near ? 'Cerca' : 'Lejos',
            event.near
              ? `Al límite le faltan ${view.rules.seismoThreshold} o menos`
              : `Al límite le faltan más de ${view.rules.seismoThreshold}`,
            event.near ? 'callout--near' : 'callout--far',
          );
          wait = 900 * pace;
        }
        break;
      case 'CardPeeked': {
        ashCloud(this.rectFor(event.playerId), this.rectFor(event.targetId));
        const { card } = event;
        if (event.playerId === this.myId && card !== undefined) {
          this.showCallout(
            'Viste',
            `${cardName(card)} de ${this.deps.who(event.targetId)}`,
            'callout--peek',
            card,
            view,
          );
          wait = 1500 * pace;
        } else {
          wait = 500 * pace;
        }
        break;
      }
      case 'CardStolen': {
        const { card } = event;
        const flying = card === undefined ? cardBack('card--flying') : cardFace(card, view.rules, 'card--flying');
        void fly(flying, this.rectFor(event.targetId), this.centerOf(this.rectFor(event.playerId)), 650, 0.5);
        if (card !== undefined && event.targetId === this.myId) {
          this.showCallout('Te robaron', cardName(card), 'callout--near');
        }
        wait = 800 * pace;
        break;
      }
      case 'MatchEnded':
        this.timer.classList.remove('timer--running');
        this.deps.onEnd(event.result);
        break;
      case 'MatchStarted':
      case 'DeckShuffled':
      case 'DiscardReshuffled':
      case 'CardDrawn':
      case 'PlayerEliminated':
        break;
    }
    this.render(deferStage);
    return wait;
  }

  // --- Efectos ------------------------------------------------------------------------------------

  /** La carta vuela de quien la jugó al cráter; al caer se ve su efecto y sube (o baja) el magma. */
  private throwCard(
    event: Extract<PlayerEvent, { type: 'CardPlayed' }>,
    view: PlayerView,
    pressureBefore: number,
    from: DOMRect | null,
  ): void {
    const { card } = event;
    const land = (): void => {
      this.played.replaceChildren(cardFace(card, view.rules, 'card--played'));
      this.renderStage(view);
      const crater = this.volcano.crater();
      const delta = event.pressureAfter - pressureBefore;
      if (delta !== 0) {
        floatText(
          this.centerOf(rectOf(this.pressure)),
          delta > 0 ? `+${delta}` : `−${-delta}`,
          delta > 0 ? 'up' : 'down',
        );
      }
      switch (card.kind) {
        case 'stone':
          splash(crater, card.value >= 3 ? 2 : 1);
          break;
        case 'bomb':
          splash(crater, 3);
          this.volcano.jolt(true);
          flash(false);
          break;
        case 'quake':
          splash(crater, 2);
          this.volcano.jolt(false);
          break;
        case 'cool':
          steam(crater, false);
          break;
        case 'rain':
          rainOver(this.volcano.el.getBoundingClientRect());
          steam(crater, true);
          break;
        case 'seismo':
          seismoLine(this.stage.getBoundingClientRect());
          break;
        case 'divert':
        case 'ash':
        case 'steal':
          break;
        case 'shield': {
          const owner = this.playerEl(event.playerId);
          if (owner !== null) replay(owner, 'shield-pop');
          break;
        }
      }
    };
    if (from === null || prefersReducedMotion()) {
      land();
      return;
    }
    void fly(cardFace(card, view.rules, 'card--flying'), from, this.volcano.crater(), FLIGHT_MS).then(land);
  }

  private erupt(playerId: string, limit: number, shielded: boolean): void {
    const name = this.deps.who(playerId);
    const mine = playerId === this.myId;
    this.volcano.erupt();
    // Primero retumba; la columna y las rocas salen un momento después.
    window.setTimeout(
      () => {
        flash(true);
        eruptionRocks(this.volcano.crater());
        if (shielded) {
          const owner = this.playerEl(playerId);
          shieldBreak(this.centerOf(rectOf(owner)));
        }
      },
      prefersReducedMotion() ? 0 : 450,
    );
    const detail = shielded
      ? `El límite era ${limit}. ${mine ? 'Tu escudo aguantó' : `El escudo de ${name} aguantó`}: no pierde vida.`
      : `El límite era ${limit}. ${name} ${mine ? 'pierdes' : 'pierde'} una vida.`;
    this.showCallout('¡Erupción!', detail, 'callout--eruption');
  }

  /** El elemento que representa a un jugador en la mesa: su ficha de rival, o la propia abajo. */
  private playerEl(playerId: string): HTMLElement | null {
    if (playerId === this.myId) return this.me;
    return this.rivals.querySelector<HTMLElement>(`[data-player="${CSS.escape(playerId)}"]`);
  }

  private rectFor(playerId: string): DOMRect {
    return rectOf(this.playerEl(playerId)) ?? this.stage.getBoundingClientRect();
  }

  private centerOf(rect: DOMRect | null): Point {
    const r = rect ?? this.stage.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // --- Jugar ------------------------------------------------------------------------------------

  private canPlay(): boolean {
    const view = this.view;
    return (
      view !== null &&
      view.status === 'playing' &&
      view.currentPlayer === this.myId &&
      !this.pending &&
      this.queue.length === 0
    );
  }

  private select(card: Card): void {
    const view = this.view;
    if (view === null || !this.canPlay() || !isPlayable(view, card)) return;
    if (!needsTarget(card)) {
      this.choosing = null;
      this.deps.onPlay(card);
      return;
    }
    if (this.choosing?.id === card.id) {
      this.cancel();
      return;
    }
    const targets = validTargets(view);
    if (targets.length === 1 && targets[0] !== undefined) {
      this.deps.onPlay(card, targets[0]);
      return;
    }
    this.choosing = card;
    this.render();
    this.rivals.querySelector<HTMLElement>('.rival--pickable')?.focus();
  }

  private pick(targetId: string): void {
    const card = this.choosing;
    if (card === null || !this.canPlay()) return;
    this.choosing = null;
    this.render();
    this.deps.onPlay(card, targetId);
  }

  // --- Dibujo -----------------------------------------------------------------------------------

  private render(deferStage = false): void {
    const view = this.view;
    if (view === null) return;
    this.renderRivals(view);
    this.renderInfo(view);
    this.renderBanner(view);
    // El magma cambia cuando la carta cae al cráter, no cuando sale de la mano.
    window.clearTimeout(this.stageTimer);
    if (deferStage) {
      this.stageTimer = window.setTimeout(() => {
        this.renderStage(view);
      }, FLIGHT_MS + 40);
    } else {
      this.renderStage(view);
    }
    this.renderMe(view);
    this.renderHand();
  }

  private renderRivals(view: PlayerView): void {
    const others = view.players.filter((p) => p.id !== this.myId);
    const targets = this.choosing === null ? [] : validTargets(view);
    this.rivals.classList.toggle('rivals--picking', this.choosing !== null);
    this.rivals.replaceChildren(...others.map((p) => this.rival(p, view, targets)));
  }

  private rival(p: PublicPlayer, view: PlayerView, targets: readonly string[]): HTMLLIElement {
    const isTurn = view.currentPlayer === p.id && view.status === 'playing';
    const pickIndex = targets.indexOf(p.id);
    const pickable = pickIndex !== -1;
    const lives = Array.from({ length: view.rules.startingLives }, (_, i) => heart(i < p.lives));
    const backs = Array.from({ length: Math.min(p.handCount, 5) }, () => h('span', { class: 'mini-back' }));
    const name = this.deps.who(p.id);
    let tag: HTMLElement | null = null;
    if (p.eliminated) tag = h('span', { class: 'rival__tag rival__tag--out', text: 'Fuera' });
    else if (isTurn && view.playsLeft === 2)
      tag = h('span', { class: 'rival__tag rival__tag--double', text: 'Juega 2' });
    else if (isTurn) tag = h('span', { class: 'rival__tag rival__tag--thinking', text: 'Pensando' });

    const item = h(
      'li',
      {
        class: `rival${isTurn ? ' rival--turn' : ''}${p.eliminated ? ' rival--out' : ''}${pickable ? ' rival--pickable' : ''}`,
        attrs: {
          'data-player': p.id,
          'aria-current': isTurn ? 'true' : 'false',
          ...(pickable && {
            role: 'button',
            tabindex: '0',
            'aria-label': `Jugar contra ${name} (tecla ${pickIndex + 1})`,
          }),
        },
      },
      [
        h('span', { class: 'rival__name' }, [name, p.shielded ? shieldIcon('Tiene escudo') : null]),
        h('span', { class: 'rival__lives', attrs: { 'aria-label': `${p.lives} vidas` } }, lives),
        h('span', { class: 'rival__cards', attrs: { 'aria-label': `${p.handCount} cartas` } }, [
          ...backs,
          h('span', { class: 'rival__count', text: String(p.handCount) }),
        ]),
        tag,
        pickable ? h('kbd', { class: 'rival__key', text: String(pickIndex + 1) }) : null,
      ],
    );
    if (pickable) {
      item.addEventListener('click', () => {
        this.pick(p.id);
      });
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.pick(p.id);
        }
      });
    }
    return item;
  }

  private renderInfo(view: PlayerView): void {
    const seismo = view.you?.seismo;
    const peek = view.you?.peek;
    const rows: readonly (readonly [string, string, string | undefined])[] = [
      ['Ronda', `${view.round} de ${view.rules.maxRounds}`, undefined],
      ['Límite anterior', view.lastRevealedLimit === null ? 'todavía no' : String(view.lastRevealedLimit), undefined],
      [
        'Tu sismógrafo',
        seismo === null || seismo === undefined ? 'sin lectura' : seismo.near ? 'cerca' : 'lejos',
        seismo === null || seismo === undefined ? undefined : seismo.near ? 'info__value--near' : 'info__value--far',
      ],
      [
        'Viste con Ceniza',
        peek === null || peek === undefined ? 'nada' : `${cardName(peek.card)} de ${this.deps.who(peek.targetId)}`,
        peek === null || peek === undefined ? undefined : 'info__value--peek',
      ],
      ['El límite está entre', `${view.rules.limitMin} y ${view.rules.limitMax}`, undefined],
      ['Mazo', `${view.drawPileCount} cartas`, undefined],
      ['Descarte', `${view.discardCount} cartas`, undefined],
    ];
    this.info.replaceChildren(
      ...rows.flatMap(([label, value, modifier]) => [
        h('dt', { class: 'info__label', text: label }),
        h('dd', { class: `info__value${modifier === undefined ? '' : ` ${modifier}`}`, text: value }),
      ]),
    );
  }

  private renderBanner(view: PlayerView): void {
    const mine = view.currentPlayer === this.myId && view.status === 'playing';
    if (view.status === 'finished') {
      this.banner.textContent = 'Partida terminada';
    } else if (mine && this.choosing !== null) {
      this.banner.textContent = `${cardName(this.choosing)}: elige a quién (Esc para cancelar)`;
    } else if (mine && view.playsLeft === 2) {
      this.banner.textContent = 'Desvío: juega dos cartas';
    } else if (mine && this.secondPlay === this.myId) {
      this.banner.textContent = 'Desvío: te falta una carta';
    } else if (mine) {
      this.banner.textContent = 'Tu turno: elige una carta';
    } else if (view.currentPlayer !== null) {
      this.banner.textContent = `Le toca a ${this.deps.who(view.currentPlayer)}`;
    } else {
      this.banner.textContent = 'El volcán se calma…';
    }
    this.banner.classList.toggle('turn--mine', mine);
  }

  private renderStage(view: PlayerView): void {
    const { limitMin, limitMax } = view.rules;
    const changed = this.pressure.textContent !== String(view.pressure);
    this.pressure.textContent = String(view.pressure);
    if (changed) replay(this.pressure, 'pop');
    const level = view.pressure > limitMin ? 'hot' : view.pressure > limitMin - 5 ? 'warm' : 'calm';
    this.pressure.dataset['level'] = level;
    this.volcano.update(view.pressure, limitMin, limitMax, view.lastRevealedLimit);
    this.deps.onHeat(Math.min(view.pressure / limitMax, 1));
  }

  private renderMe(view: PlayerView): void {
    const me = view.players.find((p) => p.id === this.myId);
    if (me === undefined) {
      this.me.replaceChildren();
      return;
    }
    const lives = Array.from({ length: view.rules.startingLives }, (_, i) => heart(i < me.lives));
    const parts: Node[] = [
      h('span', { class: 'me__name', text: me.eliminated ? 'Quedaste fuera' : 'Tus vidas' }),
      h('span', { class: 'me__lives', attrs: { 'aria-label': `${me.lives} vidas` } }, [
        ...lives,
        me.shielded && shieldIcon('Tienes escudo'),
      ]),
    ];
    if (me.shielded) parts.push(h('span', { class: 'me__shield', text: 'Escudo puesto' }));
    this.me.replaceChildren(...parts);
  }

  private renderHand(): void {
    const view = this.view;
    const hand = view?.you?.hand ?? [];
    const playable = this.canPlay();
    const n = hand.length;
    this.hand.classList.toggle('hand--waiting', !playable);
    if (view === null) {
      this.hand.replaceChildren();
      return;
    }
    this.hand.replaceChildren(
      ...hand.map((card, i) => {
        const button = cardButton(card, i, view.rules, (c) => {
          this.select(c);
        });
        // Abanico: cada carta gira un poco según su lugar y las de los extremos bajan.
        const offset = i - (n - 1) / 2;
        button.style.setProperty('--fan-rot', `${(offset * 5).toFixed(1)}deg`);
        button.style.setProperty('--fan-y', `${(Math.abs(offset) * 10).toFixed(0)}px`);
        button.disabled = !playable || !isPlayable(view, card);
        if (this.choosing?.id === card.id) button.classList.add('card--chosen');
        return button;
      }),
    );
  }

  private addLog(line: string, type: PlayerEvent['type']): void {
    const item = h('li', { class: `log__item log__item--${type}`, text: line });
    this.log.append(item);
    while (this.log.childElementCount > 40) this.log.firstElementChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  private showCallout(title: string, detail: string, modifier: string, card?: CardFace, view?: PlayerView): void {
    this.callout.className = `callout ${modifier}`;
    const parts: Node[] = [h('strong', { class: 'callout__title', text: title })];
    if (card !== undefined && view !== undefined) parts.push(cardFace(card, view.rules, 'callout__card'));
    parts.push(h('span', { class: 'callout__detail', text: detail }));
    this.callout.replaceChildren(...parts);
    replay(this.callout, 'callout--show');
  }
}
