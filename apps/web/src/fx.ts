// Efectos de la mesa. Todos son capas temporales encima de la página (position: fixed) que se
// borran solas; con «reducir movimiento» no se dibuja ninguno, y la información queda igual en
// el registro y en los avisos.
import { prefersReducedMotion, replay } from './dom.js';

export interface Point {
  readonly x: number;
  readonly y: number;
}

const center = (r: DOMRect): Point => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

function layer(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `fx ${className}`;
  el.setAttribute('aria-hidden', 'true');
  document.body.append(el);
  return el;
}

function removeAfter(el: Element, ms: number): void {
  window.setTimeout(() => {
    el.remove();
  }, ms);
}

/** Destello de toda la pantalla y sacudida de la mesa. */
export function flash(strong = true): void {
  const el = document.getElementById('flash');
  if (el !== null) replay(el, strong ? 'flash--on' : 'flash--soft');
  if (prefersReducedMotion() || !strong) return;
  const app = document.getElementById('app');
  if (app !== null) replay(app, 'shake');
}

interface BurstOptions {
  readonly count: number;
  /** Ángulo de apertura en radianes, centrado hacia arriba. */
  readonly spread: number;
  readonly distance: readonly [number, number];
  readonly sizes: readonly number[];
  readonly className: string;
  readonly ms: number;
  /** Cuánto caen al final (px): con gravedad dibujan un arco. */
  readonly fall: number;
}

/** Partículas que salen de un punto hacia arriba y caen en arco (lava, rocas, gotas). */
export function burst(at: Point, options: BurstOptions): void {
  if (prefersReducedMotion()) return;
  const host = layer('fx--burst');
  for (let i = 0; i < options.count; i++) {
    const p = document.createElement('span');
    p.className = options.className;
    const size = options.sizes[i % options.sizes.length] ?? 6;
    p.style.width = `${size}px`;
    p.style.height = `${size}px`;
    p.style.left = `${at.x - size / 2}px`;
    p.style.top = `${at.y - size / 2}px`;
    host.append(p);
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * options.spread;
    const [near, far] = options.distance;
    const d = near + Math.random() * (far - near);
    const dx = Math.cos(angle) * d;
    const dy = Math.sin(angle) * d;
    p.animate(
      [
        { transform: 'translate(0, 0)', opacity: 1 },
        { transform: `translate(${dx * 0.6}px, ${dy * 0.85}px)`, opacity: 1, offset: 0.45 },
        { transform: `translate(${dx}px, ${dy + options.fall}px)`, opacity: 0 },
      ],
      {
        duration: options.ms * (0.75 + Math.random() * 0.5),
        delay: Math.random() * 120,
        easing: 'ease-out',
        fill: 'both',
      },
    );
  }
  removeAfter(host, options.ms * 1.4 + 200);
}

/** Salpicadura de lava en el cráter cuando cae una piedra; más grande con la Bomba. */
export function splash(at: Point, strength: 1 | 2 | 3): void {
  burst(at, {
    count: [0, 8, 14, 26][strength] ?? 8,
    spread: Math.PI * (strength === 3 ? 1.1 : 0.7),
    distance: strength === 3 ? [70, 190] : [30, 90],
    sizes: strength === 3 ? [6, 10, 14] : [4, 6, 8],
    className: 'fx-lava',
    ms: strength === 3 ? 1100 : 800,
    fall: strength === 3 ? 120 : 60,
  });
}

/** Rocas y lava de la erupción: muchas, lejos y con caída larga. */
export function eruptionRocks(at: Point): void {
  burst(at, {
    count: 30,
    spread: Math.PI * 0.95,
    distance: [120, 340],
    sizes: [6, 10, 14, 18],
    className: 'fx-lava',
    ms: 1400,
    fall: 220,
  });
  burst(at, {
    count: 10,
    spread: Math.PI * 0.6,
    distance: [140, 300],
    sizes: [14, 20],
    className: 'fx-rock',
    ms: 1500,
    fall: 260,
  });
}

/** Nubes de vapor (Enfriar, Lluvia, o la lava que se enfría). */
export function steam(at: Point, big: boolean): void {
  if (prefersReducedMotion()) return;
  const host = layer('fx--steam');
  const n = big ? 9 : 5;
  for (let i = 0; i < n; i++) {
    const puff = document.createElement('span');
    puff.className = 'fx-steam';
    const size = (big ? 34 : 24) + Math.random() * 20;
    puff.style.width = `${size}px`;
    puff.style.height = `${size}px`;
    puff.style.left = `${at.x - size / 2 + (Math.random() - 0.5) * 60}px`;
    puff.style.top = `${at.y - size / 2}px`;
    host.append(puff);
    puff.animate(
      [
        { transform: 'translate(0, 0) scale(0.5)', opacity: 0 },
        { opacity: 0.85, offset: 0.2 },
        {
          transform: `translate(${(Math.random() - 0.5) * 80}px, ${-90 - Math.random() * 80}px) scale(1.6)`,
          opacity: 0,
        },
      ],
      { duration: 1300 + Math.random() * 500, delay: i * 70, easing: 'ease-out', fill: 'both' },
    );
  }
  removeAfter(host, 2400);
}

/** Lluvia sobre el volcán: rayas que caen en el rectángulo dado. */
export function rainOver(area: DOMRect): void {
  if (prefersReducedMotion()) return;
  const host = layer('fx--rain');
  for (let i = 0; i < 34; i++) {
    const drop = document.createElement('span');
    drop.className = 'fx-drop';
    drop.style.left = `${area.left + Math.random() * area.width}px`;
    drop.style.top = `${area.top - 40}px`;
    host.append(drop);
    drop.animate(
      [
        { transform: 'translateY(0)', opacity: 0.9 },
        { transform: `translateY(${area.height * 0.8}px)`, opacity: 0 },
      ],
      {
        duration: 520 + Math.random() * 260,
        delay: Math.random() * 600,
        easing: 'ease-in',
        fill: 'both',
      },
    );
  }
  removeAfter(host, 1600);
}

/** La línea del sismógrafo cruza el escenario. */
export function seismoLine(area: DOMRect): void {
  if (prefersReducedMotion()) return;
  const host = layer('fx--seismo');
  const ns = 'http://www.w3.org/2000/svg';
  const svgEl = document.createElementNS(ns, 'svg');
  svgEl.setAttribute('viewBox', '0 0 400 60');
  svgEl.setAttribute('preserveAspectRatio', 'none');
  svgEl.style.left = `${area.left}px`;
  svgEl.style.top = `${area.top + area.height * 0.45}px`;
  svgEl.style.width = `${area.width}px`;
  svgEl.style.height = '70px';
  const points: string[] = [];
  for (let x = 0; x <= 400; x += 10) {
    const amp = x > 120 && x < 280 ? 26 : 6;
    points.push(`${x},${30 + (x % 20 === 0 ? -1 : 1) * Math.random() * amp}`);
  }
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', points.join(' '));
  line.setAttribute('class', 'fx-seismo-line');
  svgEl.append(line);
  host.append(svgEl);
  const length = 900;
  line.style.strokeDasharray = String(length);
  line.animate(
    [
      { strokeDashoffset: length, opacity: 1 },
      { strokeDashoffset: 0, opacity: 1, offset: 0.7 },
      { strokeDashoffset: 0, opacity: 0 },
    ],
    { duration: 1200, easing: 'linear', fill: 'both' },
  );
  removeAfter(host, 1400);
}

/** Lleva un elemento de un rectángulo a un punto en arco; resuelve al llegar. */
export function fly(el: HTMLElement, from: DOMRect, to: Point, ms: number, endScale = 0.35): Promise<void> {
  if (prefersReducedMotion()) return Promise.resolve();
  const host = layer('fx--fly');
  host.append(el);
  const start = center(from);
  el.style.left = `${start.x}px`;
  el.style.top = `${start.y}px`;
  const dx = to.x - start.x;
  const dy = to.y - start.y;
  const lift = Math.min(-60, dy * 0.5 - 90);
  const animation = el.animate(
    [
      { transform: 'translate(-50%, -50%) scale(0.8) rotate(-8deg)' },
      {
        transform: `translate(calc(-50% + ${dx * 0.5}px), calc(-50% + ${lift}px)) scale(0.75) rotate(10deg)`,
        offset: 0.45,
      },
      {
        transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(${endScale}) rotate(24deg)`,
        opacity: 0.6,
      },
    ],
    { duration: ms, easing: 'cubic-bezier(0.45, 0, 0.7, 1)', fill: 'forwards' },
  );
  return animation.finished.then(
    () => {
      host.remove();
    },
    () => {
      host.remove();
    },
  );
}

/** Nube de ceniza que va de quien juega Ceniza hasta el rival. */
export function ashCloud(from: DOMRect, to: DOMRect): void {
  if (prefersReducedMotion()) return;
  const host = layer('fx--ash');
  const a = center(from);
  const b = center(to);
  for (let i = 0; i < 10; i++) {
    const bit = document.createElement('span');
    bit.className = 'fx-ash';
    const size = 10 + Math.random() * 14;
    bit.style.width = `${size}px`;
    bit.style.height = `${size}px`;
    bit.style.left = `${a.x}px`;
    bit.style.top = `${a.y}px`;
    host.append(bit);
    const jitter = (): number => (Math.random() - 0.5) * 50;
    bit.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.4)', opacity: 0 },
        { opacity: 0.9, offset: 0.2 },
        {
          transform: `translate(calc(-50% + ${b.x - a.x + jitter()}px), calc(-50% + ${b.y - a.y + jitter()}px)) scale(1.4)`,
          opacity: 0,
        },
      ],
      { duration: 900, delay: i * 40, easing: 'ease-in-out', fill: 'both' },
    );
  }
  removeAfter(host, 1500);
}

/** Un número que sube y se desvanece (lo que cambió la presión). */
export function floatText(at: Point, text: string, tone: 'up' | 'down' | 'neutral'): void {
  if (prefersReducedMotion()) return;
  const host = layer('fx--float');
  const label = document.createElement('span');
  label.className = `fx-float fx-float--${tone}`;
  label.textContent = text;
  label.style.left = `${at.x}px`;
  label.style.top = `${at.y}px`;
  host.append(label);
  label.animate(
    [
      { transform: 'translate(-50%, -50%) scale(0.6)', opacity: 0 },
      { transform: 'translate(-50%, -90%) scale(1.15)', opacity: 1, offset: 0.2 },
      { transform: 'translate(-50%, -260%) scale(1)', opacity: 0 },
    ],
    { duration: 1300, easing: 'ease-out', fill: 'both' },
  );
  removeAfter(host, 1400);
}

/** El escudo se rompe en pedazos de obsidiana. */
export function shieldBreak(at: Point): void {
  burst(at, {
    count: 14,
    spread: Math.PI * 2,
    distance: [40, 110],
    sizes: [8, 12],
    className: 'fx-obsidian',
    ms: 900,
    fall: 80,
  });
}

export const rectOf = (el: Element | null): DOMRect | null => (el === null ? null : el.getBoundingClientRect());
