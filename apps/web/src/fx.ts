import { prefersReducedMotion, replay } from './dom.js';

/**
 * La erupción: la pantalla tiembla, hay un destello naranja y salen chispas del cráter. Es el único
 * momento de la partida con un efecto grande; con «reducir movimiento» queda solo el destello.
 */
export function burst(volcano: SVGSVGElement): void {
  const flash = document.getElementById('flash');
  if (flash !== null) replay(flash, 'flash--on');
  if (prefersReducedMotion()) return;

  const app = document.getElementById('app');
  if (app !== null) replay(app, 'shake');

  const box = volcano.getBoundingClientRect();
  // El cráter está a un 30 % del alto del dibujo.
  const x = box.left + box.width / 2;
  const y = box.top + box.height * 0.3;
  const layer = document.createElement('div');
  layer.className = 'sparks';
  layer.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 28; i++) {
    const spark = document.createElement('span');
    spark.className = 'spark';
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
    const distance = 120 + Math.random() * 220;
    spark.style.setProperty('--x0', `${x}px`);
    spark.style.setProperty('--y0', `${y}px`);
    spark.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    spark.style.setProperty('--dy', `${Math.sin(angle) * distance}px`);
    spark.style.setProperty('--delay', `${Math.random() * 120}ms`);
    spark.style.setProperty('--size', `${6 + Math.floor(Math.random() * 3) * 4}px`);
    layer.append(spark);
  }
  document.body.append(layer);
  window.setTimeout(() => {
    layer.remove();
  }, 1400);
}
