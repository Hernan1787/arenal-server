import { svg } from './dom.js';

/**
 * El volcán del centro de la mesa. El conducto es el medidor: el magma sube con la presión, y la
 * franja marcada es donde puede estar el límite secreto de la ronda (entre limitMin y limitMax).
 * Todo lo que se mueve (humo, burbujas, temblor) depende solo de la presión, que es pública: el
 * dibujo nunca sabe dónde está el límite de verdad.
 */
export interface Volcano {
  readonly el: SVGSVGElement;
  update(pressure: number, limitMin: number, limitMax: number, lastLimit: number | null): void;
  /** La erupción en tres tiempos: retumbo, columna de lava y lava bajando por las laderas. */
  erupt(): void;
  /** Sacude el volcán un momento (Temblor, Bomba). */
  jolt(strong: boolean): void;
  /** Dónde está la boca del cráter en la pantalla. */
  crater(): { x: number; y: number };
}

// Coordenadas del conducto dentro del cono (viewBox 0 0 400 330).
const VENT_TOP = 104;
const VENT_BOTTOM = 304;
const VENT_X = 186;
const VENT_W = 28;
const CRATER = { x: 200, y: 98 };

export const ERUPTION_MS = 2600;

export function createVolcano(): Volcano {
  // El magma ocupa todo el conducto y se escala desde abajo: así el cambio se anima con CSS.
  const magma = svg('rect', {
    x: VENT_X,
    width: VENT_W,
    y: VENT_TOP,
    height: VENT_BOTTOM - VENT_TOP,
    class: 'v-magma',
  });
  // Una línea clara marca la superficie del magma y sube con él.
  const surface = svg('rect', { x: VENT_X, width: VENT_W, y: VENT_BOTTOM - 3, height: 4, class: 'v-surface' });
  const bubbles = svg(
    'g',
    { class: 'v-bubbles' },
    [0, 1, 2].map((i) =>
      svg('rect', { x: VENT_X + 5 + i * 8, y: VENT_BOTTOM - 8, width: 5, height: 5, class: `v-bubble v-bubble--${i}` }),
    ),
  );
  const band = svg('rect', { x: VENT_X - 10, width: VENT_W + 20, y: VENT_TOP, height: 0, class: 'v-band' });
  const lastMark = svg('g', { class: 'v-last', visibility: 'hidden' }, [
    svg('path', { d: `M${VENT_X - 26} 0 H${VENT_X - 6}`, class: 'v-last-line' }),
  ]);
  const ticks = svg('g', { class: 'v-ticks' });
  const glow = svg('ellipse', { cx: 200, cy: 98, rx: 70, ry: 26, class: 'v-glow' });
  // Humo: cuadros que salen del cráter, más espesos cuanto más presión.
  const smoke = svg(
    'g',
    { class: 'v-smoke' },
    [-14, 6, -4, 12, -10, 2].map((dx, i) => {
      const puff = svg('rect', {
        x: CRATER.x - 7 + dx,
        y: CRATER.y - 12,
        width: 14,
        height: 14,
        rx: 4,
        class: `v-puff v-puff--${i}`,
      });
      // Por CSSOM y no con el atributo style: la CSP de la página no permite estilos en línea.
      puff.style.setProperty('--drift', `${(dx * 2.2).toFixed(0)}px`);
      return puff;
    }),
  );
  // La erupción: columna de lava desde el cráter y dos ríos de lava por las laderas.
  const column = svg('rect', { x: VENT_X - 6, y: -60, width: VENT_W + 12, height: VENT_TOP + 60, class: 'v-column' });
  const flows = svg('g', { class: 'v-flows' }, [
    svg('path', { d: 'M168 104 L152 132 L138 160 L124 186 L106 214 L92 244 L72 274 L54 306', class: 'v-flow' }),
    svg('path', { d: 'M232 104 L250 134 L262 158 L278 188 L296 216 L310 246 L330 276 L348 306', class: 'v-flow' }),
  ]);

  const body = svg('g', { class: 'v-body' }, [
    glow,
    // Cono y sus capas de roca.
    svg('path', { d: 'M18 326 L158 96 L242 96 L382 326 Z', class: 'v-cone' }),
    svg('path', { d: 'M92 206 L128 200 L150 212 M262 214 L284 204 L318 210 M60 274 L102 266', class: 'v-strata' }),
    flows,
    svg('path', { d: 'M158 96 L172 108 L186 100 L200 112 L214 100 L228 108 L242 96', class: 'v-crater' }),
    // Conducto con el magma y la franja del límite.
    svg('rect', {
      x: VENT_X - 4,
      y: VENT_TOP - 4,
      width: VENT_W + 8,
      height: VENT_BOTTOM - VENT_TOP + 8,
      class: 'v-vent',
    }),
    band,
    magma,
    bubbles,
    surface,
    lastMark,
    ticks,
  ]);

  const el = svg(
    'svg',
    {
      viewBox: '0 0 400 330',
      // Pegado abajo, sobre la mano: el espacio que sobra queda arriba, para la presión y los avisos.
      preserveAspectRatio: 'xMidYMax meet',
      class: 'volcano',
      role: 'img',
      'aria-label': 'Volcán',
    },
    [
      svg('defs', {}, [
        svg('linearGradient', { id: 'v-lava', x1: 0, y1: 0, x2: 0, y2: 1 }, [
          svg('stop', { offset: '0', 'stop-color': '#FFD25A' }),
          svg('stop', { offset: '0.35', 'stop-color': '#FF7A1F' }),
          svg('stop', { offset: '1', 'stop-color': '#C2260F' }),
        ]),
        svg('linearGradient', { id: 'v-rock', x1: 0, y1: 0, x2: 1, y2: 0 }, [
          svg('stop', { offset: '0', 'stop-color': '#2C2240' }),
          svg('stop', { offset: '0.5', 'stop-color': '#3D3157' }),
          svg('stop', { offset: '1', 'stop-color': '#241B35' }),
        ]),
        svg('radialGradient', { id: 'v-glow', cx: 0.5, cy: 0.5, r: 0.5 }, [
          svg('stop', { offset: '0', 'stop-color': '#FFB23D', 'stop-opacity': '0.9' }),
          svg('stop', { offset: '1', 'stop-color': '#FF4F1F', 'stop-opacity': '0' }),
        ]),
      ]),
      smoke,
      column,
      body,
    ],
  );

  let scaleMax = 0;
  const yFor = (value: number): number =>
    VENT_BOTTOM - (Math.min(value, scaleMax) / scaleMax) * (VENT_BOTTOM - VENT_TOP);

  function drawTicks(limitMax: number): void {
    ticks.replaceChildren();
    for (let value = 0; value <= limitMax; value += 5) {
      const y = yFor(value);
      ticks.append(
        svg('path', { d: `M${VENT_X + VENT_W + 6} ${y} H${VENT_X + VENT_W + 16}`, class: 'v-tick' }),
        svg('text', { x: VENT_X + VENT_W + 22, y: y + 6, class: 'v-tick-label' }, [String(value)]),
      );
    }
  }

  let eruptTimer = 0;
  let joltTimer = 0;

  return {
    el,
    update(pressure, limitMin, limitMax, lastLimit) {
      if (scaleMax !== limitMax) {
        scaleMax = limitMax;
        drawTicks(limitMax);
      }
      const level = Math.min(pressure, limitMax) / limitMax;
      magma.style.setProperty('transform', `scaleY(${level.toFixed(3)})`);
      // Lo que sube la superficie desde el fondo del conducto, en unidades del dibujo.
      const rise = (VENT_BOTTOM - yFor(pressure)).toFixed(1);
      surface.style.setProperty('transform', `translateY(-${rise}px)`);
      el.style.setProperty('--rise', `-${rise}px`);
      el.classList.toggle('volcano--empty', pressure === 0);
      // Desde limitMin hasta el tope puede estar el límite: la franja de peligro.
      const bandTop = yFor(limitMax);
      band.setAttribute('y', String(bandTop));
      band.setAttribute('height', String(yFor(limitMin) - bandTop));
      if (lastLimit === null) {
        lastMark.setAttribute('visibility', 'hidden');
      } else {
        lastMark.setAttribute('visibility', 'visible');
        lastMark.setAttribute('transform', `translate(0 ${yFor(lastLimit)})`);
      }
      const heat = Math.min(pressure / limitMax, 1);
      glow.style.setProperty('opacity', String(0.15 + heat * 0.85));
      el.style.setProperty('--heat', heat.toFixed(2));
      // Dentro de la franja el volcán retumba, y más fuerte cuanto más adentro.
      const danger = pressure <= limitMin ? 0 : Math.min((pressure - limitMin) / Math.max(limitMax - limitMin, 1), 1);
      el.style.setProperty('--danger', danger.toFixed(2));
      el.classList.toggle('volcano--rumble', danger > 0);
    },
    erupt() {
      window.clearTimeout(eruptTimer);
      el.classList.remove('volcano--erupting');
      el.getBoundingClientRect();
      el.classList.add('volcano--erupting');
      eruptTimer = window.setTimeout(() => {
        el.classList.remove('volcano--erupting');
      }, ERUPTION_MS + 400);
    },
    jolt(strong) {
      window.clearTimeout(joltTimer);
      el.classList.remove('volcano--jolt', 'volcano--jolt-strong');
      el.getBoundingClientRect();
      el.classList.add(strong ? 'volcano--jolt-strong' : 'volcano--jolt');
      joltTimer = window.setTimeout(() => {
        el.classList.remove('volcano--jolt', 'volcano--jolt-strong');
      }, 700);
    },
    crater() {
      const matrix = el.getScreenCTM();
      if (matrix === null) {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height * 0.3 };
      }
      const point = new DOMPoint(CRATER.x, CRATER.y).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    },
  };
}
