import { cardName } from '@arenal/client';
import type { Card } from '@arenal/domain';
import { h, svg } from './dom.js';

/** Lo que hace la carta, en una marca corta para la esquina. */
export function cardEffect(card: Card, coolAmount: number): string {
  if (card.kind === 'stone') return `+${card.value}`;
  if (card.kind === 'cool') return `−${coolAmount}`;
  return '?';
}

// Rocas facetadas: una por cada punto de la piedra, acomodadas como en un dado.
const ROCK_POSITIONS: readonly (readonly (readonly [number, number])[])[] = [
  [[21, 22]],
  [
    [12, 14],
    [30, 30],
  ],
  [
    [10, 10],
    [32, 14],
    [21, 32],
  ],
  [
    [10, 10],
    [32, 10],
    [10, 32],
    [32, 32],
  ],
];
const ROCK = 'M3 10 L6 4 L12 2 L17 5 L18 11 L13 15 L6 14 Z';
const ROCK_FACET = 'M6 4 L10 8 L17 5 M10 8 L13 15';

function art(card: Card): SVGSVGElement {
  if (card.kind === 'stone') {
    const positions = ROCK_POSITIONS[card.value - 1] ?? [];
    return svg(
      'svg',
      { viewBox: '0 0 62 56', class: 'card__art', 'aria-hidden': 'true' },
      positions.map(([x, y]) =>
        svg('g', { transform: `translate(${x} ${y})` }, [
          svg('path', { d: ROCK, class: 'rock' }),
          svg('path', { d: ROCK_FACET, class: 'rock-facet' }),
        ]),
      ),
    );
  }
  if (card.kind === 'cool') {
    return svg('svg', { viewBox: '0 0 62 56', class: 'card__art', 'aria-hidden': 'true' }, [
      svg('path', { d: 'M31 6 C40 20 46 28 46 36 A15 15 0 0 1 16 36 C16 28 22 20 31 6 Z', class: 'drop' }),
      svg('path', { d: 'M24 36 A7 7 0 0 0 31 43', class: 'drop-shine' }),
    ]);
  }
  return svg('svg', { viewBox: '0 0 62 56', class: 'card__art', 'aria-hidden': 'true' }, [
    svg('path', { d: 'M2 30 H14 L18 22 L24 42 L30 10 L36 46 L41 24 L45 34 L48 30 H60', class: 'wave' }),
  ]);
}

/** Una carta de la mano: un botón que juega la carta. */
export function cardButton(
  card: Card,
  index: number,
  coolAmount: number,
  onPlay: (card: Card) => void,
): HTMLButtonElement {
  const name = cardName(card);
  return h(
    'button',
    {
      class: `card card--${card.kind}`,
      attrs: { type: 'button', 'aria-label': `Jugar ${name} (tecla ${index + 1})`, 'data-card': card.id },
      on: {
        click: () => {
          onPlay(card);
        },
      },
    },
    [
      h('span', { class: 'card__effect', text: cardEffect(card, coolAmount) }),
      art(card),
      h('span', { class: 'card__name', text: card.kind === 'stone' ? 'Piedra' : name }),
      h('kbd', { class: 'card__key', text: String(index + 1) }),
    ],
  );
}

/** La carta que se acaba de jugar, grande, en el centro de la mesa. */
export function playedCard(card: Card, coolAmount: number): HTMLElement {
  return h('div', { class: `card card--${card.kind} card--played`, attrs: { 'aria-hidden': 'true' } }, [
    h('span', { class: 'card__effect', text: cardEffect(card, coolAmount) }),
    art(card),
    h('span', { class: 'card__name', text: card.kind === 'stone' ? 'Piedra' : cardName(card) }),
  ]);
}
