import { svg } from './dom.js';

/**
 * El volcán del centro de la mesa. El conducto es el medidor: el magma sube con la presión, y la
 * franja marcada es donde puede estar el límite secreto de la ronda (entre limitMin y limitMax).
 */
export interface Volcano {
  readonly el: SVGSVGElement;
  update(pressure: number, limitMin: number, limitMax: number, lastLimit: number | null): void;
}

// Coordenadas del conducto dentro del cono (viewBox 0 0 400 330).
const VENT_TOP = 104;
const VENT_BOTTOM = 304;
const VENT_X = 186;
const VENT_W = 28;

export function createVolcano(): Volcano {
  // El magma ocupa todo el conducto y se escala desde abajo: así el cambio se anima con CSS.
  const magma = svg('rect', {
    x: VENT_X,
    width: VENT_W,
    y: VENT_TOP,
    height: VENT_BOTTOM - VENT_TOP,
    class: 'v-magma',
  });
  const band = svg('rect', { x: VENT_X - 10, width: VENT_W + 20, y: VENT_TOP, height: 0, class: 'v-band' });
  const lastMark = svg('g', { class: 'v-last', visibility: 'hidden' }, [
    svg('path', { d: `M${VENT_X - 26} 0 H${VENT_X - 6}`, class: 'v-last-line' }),
  ]);
  const ticks = svg('g', { class: 'v-ticks' });
  const glow = svg('ellipse', { cx: 200, cy: 98, rx: 70, ry: 26, class: 'v-glow' });

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
      glow,
      // Cono y sus capas de roca.
      svg('path', { d: 'M18 326 L158 96 L242 96 L382 326 Z', class: 'v-cone' }),
      svg('path', { d: 'M92 206 L128 200 L150 212 M262 214 L284 204 L318 210 M60 274 L102 266', class: 'v-strata' }),
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
      lastMark,
      ticks,
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

  return {
    el,
    update(pressure, limitMin, limitMax, lastLimit) {
      if (scaleMax !== limitMax) {
        scaleMax = limitMax;
        drawTicks(limitMax);
      }
      magma.style.setProperty('transform', `scaleY(${(Math.min(pressure, limitMax) / limitMax).toFixed(3)})`);
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
    },
  };
}
