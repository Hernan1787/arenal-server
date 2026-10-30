import { createMatch, type GameState } from '@arenal/domain';
import { describe, expect, it } from 'vitest';
import { StateCache } from '../src/matches/state-cache.js';

const state = (id: string, version: number, status: GameState['status'] = 'playing'): GameState => ({
  ...createMatch(id, ['ana', 'beto']),
  status,
  version,
});

describe('caché de estado', () => {
  it('solo entrega el estado si su versión es exactamente la pedida', () => {
    const cache = new StateCache(10);
    cache.set('m1', state('m1', 5));
    expect(cache.get('m1', 5)?.version).toBe(5);
    expect(cache.get('m1', 6)).toBeUndefined();
    expect(cache.get('m2', 5)).toBeUndefined();
  });

  it('nunca reemplaza un estado más nuevo por uno más viejo', () => {
    const cache = new StateCache(10);
    cache.set('m1', state('m1', 7));
    cache.set('m1', state('m1', 6));
    expect(cache.get('m1', 7)?.version).toBe(7);
  });

  it('saca las partidas terminadas y la menos usada cuando se llena', () => {
    const cache = new StateCache(2);
    cache.set('a', state('a', 1));
    cache.set('b', state('b', 1));
    cache.get('a', 1);
    cache.set('c', state('c', 1));
    expect(cache.get('b', 1)).toBeUndefined();
    expect(cache.get('a', 1)).toBeDefined();
    cache.set('a', state('a', 2, 'finished'));
    expect(cache.get('a', 2)).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it('con capacidad 0 no guarda nada', () => {
    const cache = new StateCache(0);
    cache.set('m1', state('m1', 1));
    expect(cache.size).toBe(0);
  });
});
