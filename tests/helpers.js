/**
 * Utilitarios de teste: assercoes, fixtures deterministicas e gerador de dados.
 * Nenhuma dependencia externa.
 */

import { createSeededRng } from '../src/js/combination-engine.js';
import { getProfile } from '../src/js/game-profiles.js';

export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

export function assert(condition, message = 'condicao falsa') {
  if (!condition) throw new AssertionError(message);
}

export function assertEqual(actual, expected, message = 'valores diferentes') {
  if (actual !== expected) {
    throw new AssertionError(`${message}: esperado ${JSON.stringify(expected)}, recebido ${JSON.stringify(actual)}`);
  }
}

export function assertDeepEqual(actual, expected, message = 'estruturas diferentes') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new AssertionError(`${message}: esperado ${b}, recebido ${a}`);
}

export function assertClose(actual, expected, tolerance = 1e-9, message = 'valores fora da tolerancia') {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new AssertionError(`${message}: esperado ${expected} (+-${tolerance}), recebido ${actual}`);
  }
}

export function assertThrows(fn, message = 'esperava erro') {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new AssertionError(message);
}

export function assertRange(value, min, max, message = 'valor fora do intervalo') {
  if (!(value >= min && value <= max)) {
    throw new AssertionError(`${message}: ${value} fora de [${min}, ${max}]`);
  }
}

export function isoDate(offsetDays = 0) {
  const base = Date.UTC(2020, 0, 1);
  const date = new Date(base + offsetDays * 86400000);
  return date.toISOString().slice(0, 10);
}

/** Cria concursos deterministicos para o perfil informado. */
export function makeDraws(profile, count, seed = 'fixture') {
  const rng = createSeededRng(seed);
  const numbers = [];
  for (let number = profile.minNumber; number <= profile.maxNumber; number += 1) numbers.push(number);
  const draws = [];
  for (let index = 0; index < count; index += 1) {
    const pool = numbers.slice();
    const picked = [];
    for (let take = 0; take < profile.drawSize; take += 1) {
      const position = Math.floor(rng() * pool.length);
      picked.push(pool.splice(position, 1)[0]);
    }
    picked.sort((a, b) => a - b);
    draws.push({
      contest: index + 1,
      date: isoDate(index * 2),
      numbers: picked,
      prizes: null,
      source: 'fixture',
    });
  }
  return draws;
}

export function makeDataset(gameId, count = 20, seed = 'fixture') {
  const profile = getProfile(gameId);
  return {
    game: gameId,
    version: 1,
    datasetStatus: 'partial',
    source: 'fixture',
    lastUpdated: new Date().toISOString(),
    lastContest: count,
    hash: 'a'.repeat(64),
    draws: makeDraws(profile, count, seed),
  };
}

export function makeDraw(profile, contest, offset = 0) {
  const numbers = [];
  for (let index = 0; index < profile.drawSize; index += 1) {
    numbers.push(profile.minNumber + ((contest + index + offset) % (profile.maxNumber - profile.minNumber + 1)));
  }
  return { contest, date: isoDate(contest), numbers: [...new Set(numbers)].sort((a, b) => a - b), prizes: null };
}

export function countBy(list, key) {
  const map = new Map();
  for (const item of list) map.set(item[key], (map.get(item[key]) ?? 0) + 1);
  return map;
}
