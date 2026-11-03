import { describeEvent } from '@arenal/client';
import type { Card, PlayerEvent, PlayerView, PublicPlayer } from '@arenal/domain';
import { cardButton, playedCard } from './cards.js';
import { h, heart, replay } from './dom.js';
import { burst } from './fx.js';
import { createVolcano } from './volcano.js';

/** El servidor juega por el jugador cuando se le vence el turno (TURN_TIMEOUT_MS, 30 s por defecto). */
const TURN_MS = 30_000;

export interface TableDeps {
  readonly who: (playerId: string) => string;
  readonly onPlay: (card: Card) => void;
  readonly onHeat: (heat: number) => void;
}

/** La mesa de juego: rivales, volcán, información de la ronda, registro y la mano propia. */
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
  private readonly log = h('ol', { class: 'log__list', attrs: { 'aria-live': 'polite' } });
  private readonly me = h('div', { class: 'me' });
  private readonly hand = h('div', { class: 'hand', attrs: { role: 'group', 'aria-label': 'Tu mano' } });
  private view: PlayerView | null = null;
  private myId = '';
  private pending = false;

  constructor(private readonly deps: TableDeps) {
    this.el = h('section', { class: 'table', attrs: { 'aria-label': 'Mesa de juego' } }, [
      h('header', { class: 'table__rivals' }, [this.rivals]),
      h('aside', { class: 'panel table__info', attrs: { 'aria-label': 'La ronda' } }, [this.info]),
      h('div', { class: 'stage' }, [
        this.banner,
        this.timer,
        h('div', { class: 'pressure' }, [this.pressure, h('span', { class: 'pressure__label', text: 'de presión' })]),
        this.volcano.el,
        this.played,
        this.callout,
      ]),
      h('aside', { class: 'panel log', attrs: { 'aria-label': 'Lo que pasó' } }, [
        h('h2', { class: 'panel__title', text: 'Lo que pasó' }),
        this.log,
      ]),
      h('footer', { class: 'table__hand' }, [this.me, this.hand]),
    ]);
  }

  /** Estado completo (al conectar o al reconectar): se redibuja todo, sin efectos. */
  load(view: PlayerView, myId: string, fresh: boolean): void {
    this.myId = myId;
    this.view = view;
    if (fresh) {
      this.log.replaceChildren();
      this.played.replaceChildren();
      this.timer.classList.remove('timer--running');
    }
    this.render();
  }

  /** Un evento nuevo: se actualiza la vista y se muestra el efecto que corresponde. */
  event(event: PlayerEvent, view: PlayerView): void {
    this.view = view;
    const line = describeEvent(event, this.myId, this.deps.who);
    if (line !== null) this.addLog(line, event.type);
    switch (event.type) {
      case 'CardPlayed': {
        const card = playedCard(event.card, view.rules.coolAmount);
        this.played.replaceChildren(card);
        replay(this.pressure, 'pop');
        break;
      }
      case 'TurnStarted':
        this.timer.style.setProperty('--turn-ms', `${TURN_MS}ms`);
        replay(this.timer, 'timer--running');
        if (event.playerId === this.myId) replay(this.hand, 'hand--wake');
        break;
      case 'Eruption':
        this.timer.classList.remove('timer--running');
        this.showCallout(
          '¡Erupción!',
          `El límite era ${event.limit}. ${this.deps.who(event.playerId)} ${event.playerId === this.myId ? 'pierdes' : 'pierde'} una vida.`,
          'callout--eruption',
        );
        burst(this.volcano.el);
        break;
      case 'RoundStarted':
        if (event.round > 1) this.showCallout(`Ronda ${event.round}`, 'Límite nuevo, secreto', 'callout--round');
        this.played.replaceChildren();
        break;
      case 'SeismoRead':
        if (event.playerId === this.myId && event.near !== undefined) {
          this.showCallout(
            event.near ? 'Cerca' : 'Lejos',
            event.near ? 'Al límite le faltan 4 o menos' : 'Al límite le faltan más de 4',
            event.near ? 'callout--near' : 'callout--far',
          );
        }
        break;
      case 'MatchEnded':
        this.timer.classList.remove('timer--running');
        break;
      case 'MatchStarted':
      case 'DeckShuffled':
      case 'DiscardReshuffled':
      case 'CardDrawn':
      case 'PlayerEliminated':
        break;
    }
    this.render();
  }

  /** Mientras una jugada espera respuesta del servidor, la mano no acepta otra. */
  setPending(pending: boolean): void {
    this.pending = pending;
    this.renderHand();
  }

  /** Juega la carta en esa posición (teclas 1 a 9). */
  playAt(index: number): void {
    const card = this.view?.you?.hand[index];
    if (card !== undefined && this.canPlay()) this.deps.onPlay(card);
  }

  private canPlay(): boolean {
    const view = this.view;
    return view !== null && view.status === 'playing' && view.currentPlayer === this.myId && !this.pending;
  }

  private render(): void {
    const view = this.view;
    if (view === null) return;
    this.renderRivals(view);
    this.renderInfo(view);
    this.renderStage(view);
    this.renderMe(view);
    this.renderHand();
  }

  private renderRivals(view: PlayerView): void {
    const others = view.players.filter((p) => p.id !== this.myId);
    this.rivals.replaceChildren(...others.map((p) => this.rival(p, view)));
  }

  private rival(p: PublicPlayer, view: PlayerView): HTMLLIElement {
    const isTurn = view.currentPlayer === p.id && view.status === 'playing';
    const lives = Array.from({ length: view.rules.startingLives }, (_, i) => heart(i < p.lives));
    const backs = Array.from({ length: Math.min(p.handCount, 5) }, () => h('span', { class: 'mini-back' }));
    return h(
      'li',
      {
        class: `rival${isTurn ? ' rival--turn' : ''}${p.eliminated ? ' rival--out' : ''}`,
        attrs: { 'aria-current': isTurn ? 'true' : 'false' },
      },
      [
        h('span', { class: 'rival__name', text: this.deps.who(p.id) }),
        h('span', { class: 'rival__lives', attrs: { 'aria-label': `${p.lives} vidas` } }, lives),
        h('span', { class: 'rival__cards', attrs: { 'aria-label': `${p.handCount} cartas` } }, [
          ...backs,
          h('span', { class: 'rival__count', text: String(p.handCount) }),
        ]),
        isTurn ? h('span', { class: 'rival__tag', text: 'Le toca' }) : null,
        p.eliminated ? h('span', { class: 'rival__tag rival__tag--out', text: 'Fuera' }) : null,
      ],
    );
  }

  private renderInfo(view: PlayerView): void {
    const seismo = view.you?.seismo;
    const rows: readonly (readonly [string, string, string | undefined])[] = [
      ['Ronda', `${view.round} de ${view.rules.maxRounds}`, undefined],
      ['Límite anterior', view.lastRevealedLimit === null ? 'todavía no' : String(view.lastRevealedLimit), undefined],
      [
        'Tu sismógrafo',
        seismo === null || seismo === undefined ? 'sin lectura' : seismo.near ? 'cerca' : 'lejos',
        seismo === null || seismo === undefined ? undefined : seismo.near ? 'info__value--near' : 'info__value--far',
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

  private renderStage(view: PlayerView): void {
    const { limitMin, limitMax } = view.rules;
    this.pressure.textContent = String(view.pressure);
    const level = view.pressure > limitMin ? 'hot' : view.pressure > limitMin - 5 ? 'warm' : 'calm';
    this.pressure.dataset['level'] = level;
    this.volcano.update(view.pressure, limitMin, limitMax, view.lastRevealedLimit);
    this.deps.onHeat(Math.min(view.pressure / limitMax, 1));

    if (view.status === 'finished') {
      this.banner.textContent = 'Partida terminada';
    } else if (view.currentPlayer === this.myId) {
      this.banner.textContent = 'Tu turno: elige una carta';
    } else if (view.currentPlayer !== null) {
      this.banner.textContent = `Le toca a ${this.deps.who(view.currentPlayer)}`;
    } else {
      this.banner.textContent = 'El volcán se calma…';
    }
    this.banner.classList.toggle('turn--mine', view.currentPlayer === this.myId && view.status === 'playing');
  }

  private renderMe(view: PlayerView): void {
    const me = view.players.find((p) => p.id === this.myId);
    if (me === undefined) {
      this.me.replaceChildren();
      return;
    }
    const lives = Array.from({ length: view.rules.startingLives }, (_, i) => heart(i < me.lives));
    this.me.replaceChildren(
      h('span', { class: 'me__name', text: me.eliminated ? 'Quedaste fuera' : 'Tus vidas' }),
      h('span', { class: 'me__lives', attrs: { 'aria-label': `${me.lives} vidas` } }, lives),
    );
  }

  private renderHand(): void {
    const view = this.view;
    const hand = view?.you?.hand ?? [];
    const playable = this.canPlay();
    const n = hand.length;
    this.hand.classList.toggle('hand--waiting', !playable);
    this.hand.replaceChildren(
      ...hand.map((card, i) => {
        const button = cardButton(card, i, view?.rules.coolAmount ?? 3, (c) => {
          if (this.canPlay()) this.deps.onPlay(c);
        });
        // Abanico: cada carta gira un poco según su lugar y las de los extremos bajan.
        const offset = i - (n - 1) / 2;
        button.style.setProperty('--fan-rot', `${(offset * 5).toFixed(1)}deg`);
        button.style.setProperty('--fan-y', `${(Math.abs(offset) * 10).toFixed(0)}px`);
        button.disabled = !playable;
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

  private showCallout(title: string, detail: string, modifier: string): void {
    this.callout.className = `callout ${modifier}`;
    this.callout.replaceChildren(
      h('strong', { class: 'callout__title', text: title }),
      h('span', { class: 'callout__detail', text: detail }),
    );
    replay(this.callout, 'callout--show');
  }
}
