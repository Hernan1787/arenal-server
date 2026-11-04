import { cardHelp, cardName } from '@arenal/client';
import type { Card, CardFace, PublicRules } from '@arenal/domain';
import { h, heart, svg } from './dom.js';

/** Lo que hace la carta, en una marca corta para la esquina. */
export function cardEffect(card: CardFace, rules: PublicRules): string {
  switch (card.kind) {
    case 'stone':
      return `+${card.value}`;
    case 'bomb':
      return `+${rules.bombAmount}`;
    case 'quake':
      return `+${rules.quakeMin}-${rules.quakeMax}`;
    case 'cool':
      return `−${rules.coolAmount}`;
    case 'rain':
      return `−${rules.rainAmount}`;
    case 'seismo':
      return '?';
    case 'divert':
      return '×2';
    case 'ash':
      return 'ver';
    case 'steal':
      return 'robo';
    case 'shield':
      return '';
  }
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

const rock = (x: number, y: number, scale = 1): SVGGElement =>
  svg('g', { transform: `translate(${x} ${y}) scale(${scale})` }, [
    svg('path', { d: ROCK, class: 'rock' }),
    svg('path', { d: ROCK_FACET, class: 'rock-facet' }),
  ]);

const box = (children: SVGElement[]): SVGSVGElement =>
  svg('svg', { viewBox: '0 0 62 56', class: 'card__art', 'aria-hidden': 'true' }, children);

/** El dibujo de cada carta, en el mismo estilo de trazo grueso. */
export function cardArt(card: CardFace): SVGSVGElement {
  switch (card.kind) {
    case 'stone':
      return box((ROCK_POSITIONS[card.value - 1] ?? []).map(([x, y]) => rock(x, y)));
    case 'bomb':
      return box([
        svg('path', { d: 'M38 18 C42 12 46 10 50 9', class: 'fuse' }),
        svg('path', { d: 'M50 3 L52 8 L57 9 L52 11 L50 16 L48 11 L43 9 L48 8 Z', class: 'fuse-spark' }),
        svg('circle', { cx: 28, cy: 34, r: 17, class: 'bomb' }),
        svg('rect', { x: 32, y: 14, width: 10, height: 8, rx: 2, class: 'bomb-cap' }),
        svg('path', { d: 'M18 30 A11 11 0 0 1 26 22', class: 'bomb-shine' }),
      ]);
    case 'quake':
      return box([
        svg('path', { d: 'M2 38 H18 L23 30 L28 46 L34 32 L38 40 L42 34 H60', class: 'crack' }),
        svg('path', { d: 'M2 46 H60', class: 'ground' }),
        rock(8, 10, 0.8),
        rock(40, 4, 0.7),
        svg('path', { d: 'M27 8 V18 M23 12 H31', class: 'shock' }),
      ]);
    case 'cool':
      return box([
        svg('path', { d: 'M31 6 C40 20 46 28 46 36 A15 15 0 0 1 16 36 C16 28 22 20 31 6 Z', class: 'drop' }),
        svg('path', { d: 'M24 36 A7 7 0 0 0 31 43', class: 'drop-shine' }),
      ]);
    case 'rain':
      return box([
        svg('path', {
          d: 'M14 30 A9 9 0 0 1 18 13 A12 12 0 0 1 40 10 A10 10 0 0 1 50 30 Z',
          class: 'cloud',
        }),
        svg('path', { d: 'M18 36 L15 44 M30 36 L27 48 M42 36 L39 44', class: 'rain-line' }),
      ]);
    case 'seismo':
      return box([svg('path', { d: 'M2 30 H14 L18 22 L24 42 L30 10 L36 46 L41 24 L45 34 L48 30 H60', class: 'wave' })]);
    case 'divert':
      return box([
        svg('path', { d: 'M10 44 C10 22 30 12 46 20', class: 'divert-arrow' }),
        svg('path', { d: 'M38 12 L50 21 L37 29', class: 'divert-arrow' }),
        svg('path', { d: 'M34 40 H46 M40 34 V46', class: 'divert-plus' }),
      ]);
    case 'ash':
      return box([
        svg('path', { d: 'M6 28 Q31 6 56 28 Q31 50 6 28 Z', class: 'eye' }),
        svg('circle', { cx: 31, cy: 28, r: 8, class: 'eye-iris' }),
        svg('rect', { x: 29, y: 26, width: 4, height: 4, class: 'eye-pupil' }),
        svg('path', { d: 'M8 10 h3 v3 h-3z M52 8 h3 v3 h-3z M46 46 h3 v3 h-3z M12 44 h3 v3 h-3z', class: 'ash-dot' }),
      ]);
    case 'steal':
      return box([
        svg('rect', { x: 26, y: 8, width: 22, height: 30, rx: 4, class: 'stolen-card', transform: 'rotate(14 37 23)' }),
        svg('path', { d: 'M8 40 C8 52 26 52 26 40 V30', class: 'hook' }),
        svg('path', { d: 'M20 34 L26 26 L32 34', class: 'hook' }),
      ]);
    case 'shield':
      return box([
        svg('path', { d: 'M31 4 L52 12 V28 C52 40 42 48 31 52 C20 48 10 40 10 28 V12 Z', class: 'shield' }),
        svg('path', { d: 'M31 4 V52 M10 20 L31 28 L52 20', class: 'shield-facet' }),
      ]);
  }
}

function corner(card: CardFace, rules: PublicRules): HTMLElement {
  const text = cardEffect(card, rules);
  if (card.kind === 'shield') {
    return h('span', { class: 'card__effect card__effect--icon', attrs: { 'aria-hidden': 'true' } }, [heart(true)]);
  }
  return h('span', { class: `card__effect${text.length > 2 ? ' card__effect--small' : ''}`, text });
}

/** El nombre corto que va abajo de la carta (las piedras dicen solo «Piedra»: el número va arriba). */
const shortName = (card: CardFace): string => (card.kind === 'stone' ? 'Piedra' : cardName(card));

/** Una carta de la mano: un botón que juega la carta. */
export function cardButton(
  card: Card,
  index: number,
  rules: PublicRules,
  onPlay: (card: Card) => void,
): HTMLButtonElement {
  const name = cardName(card);
  return h(
    'button',
    {
      class: `card card--${card.kind}`,
      attrs: {
        type: 'button',
        'aria-label': `Jugar ${name} (tecla ${index + 1}). ${cardHelp(card, rules)}`,
        title: cardHelp(card, rules),
        'data-card': card.id,
      },
      on: {
        click: () => {
          onPlay(card);
        },
      },
    },
    [
      corner(card, rules),
      cardArt(card),
      h('span', { class: 'card__name', text: shortName(card) }),
      h('kbd', { class: 'card__key', text: String(index + 1) }),
    ],
  );
}

/** Una carta para mostrar (la última jugada, la que vuela al cráter, la que se vio con Ceniza). */
export function cardFace(card: CardFace, rules: PublicRules, extraClass = ''): HTMLElement {
  return h(
    'div',
    { class: `card card--${card.kind}${extraClass === '' ? '' : ` ${extraClass}`}`, attrs: { 'aria-hidden': 'true' } },
    [corner(card, rules), cardArt(card), h('span', { class: 'card__name', text: shortName(card) })],
  );
}

/** El reverso de una carta (la que se roba: nadie más que los dos sabe cuál es). */
export function cardBack(extraClass = ''): HTMLElement {
  return h('div', {
    class: `card card--back${extraClass === '' ? '' : ` ${extraClass}`}`,
    attrs: { 'aria-hidden': 'true' },
  });
}
