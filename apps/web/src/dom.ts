// Helpers mínimos para armar el DOM sin plantillas de texto: todo el contenido entra con
// textContent, así un nombre de jugador nunca se interpreta como HTML.

type Child = Node | string | null | undefined | false;

interface Options {
  readonly class?: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly on?: Readonly<Record<string, (event: Event) => void>>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: Options = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (options.class !== undefined) el.className = options.class;
  if (options.text !== undefined) el.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) el.setAttribute(name, value);
  for (const [name, handler] of Object.entries(options.on ?? {})) el.addEventListener(name, handler);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, string | number>> = {},
  children: readonly (SVGElement | string)[] = [],
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  for (const child of children) el.append(child);
  return el;
}

export function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`Falta el elemento #${id}`);
  return el;
}

/** Corazón de 7×6 "píxeles". */
export function heart(filled: boolean): SVGSVGElement {
  return svg('svg', { viewBox: '0 0 7 6', class: `heart${filled ? '' : ' heart--empty'}`, 'aria-hidden': 'true' }, [
    svg('path', {
      d: 'M1 0h2v1h1V0h2v1h1v2H6v1H5v1H4v1H3V5H2V4H1V3H0V1h1z',
      'shape-rendering': 'crispEdges',
    }),
  ]);
}

export const prefersReducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Quita una clase y la vuelve a poner para reiniciar su animación. */
export function replay(el: Element, className: string): void {
  el.classList.remove(className);
  // Leer el tamaño obliga al navegador a aplicar el cambio antes de volver a poner la clase.
  el.getBoundingClientRect();
  el.classList.add(className);
}
