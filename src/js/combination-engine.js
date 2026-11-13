/**
 * Geracao, filtragem, ranking, diversidade e fechamentos.
 * Tudo puro e deterministico quando uma seed e fornecida.
 */

import { encodeCombination, jaccard, maskKey } from './bitmask.js';
import { boardCell, coreNumbers, frameNumbers, isFibonacci, isPrime } from './game-profiles.js';
import { scoreBatch } from './scoring-engine.js';
import { clamp, roundTo } from './statistics.js';

/* ------------------------------------------------------------------ */
/* Aleatoriedade                                                       */
/* ------------------------------------------------------------------ */

/** PRNG deterministico (mulberry32). Mesma seed + mesma sequencia = mesmo resultado. */
export function createSeededRng(seed) {
  let state = hashSeed(seed);
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed) {
  const text = String(seed ?? '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** RNG criptografico com fallback para Math.random (ex.: ambiente sem crypto). */
export function createCryptoRng() {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    return function next() {
      const buffer = new Uint32Array(1);
      globalThis.crypto.getRandomValues(buffer);
      return buffer[0] / 4294967296;
    };
  }
  return Math.random;
}

/** RNG padrao da aplicacao: quando ha seed, deterministico; caso contrario, criptografico. */
export function resolveRng(seed) {
  if (seed === undefined || seed === null || seed === '') return { rng: createCryptoRng(), seeded: false };
  return { rng: createSeededRng(seed), seeded: true, seed: String(seed) };
}

/** Amostra k dezenas distintas de um pool (Fisher-Yates parcial). */
export function sampleDistinct(pool, k, rng) {
  const copy = pool.slice();
  const take = Math.min(k, copy.length);
  for (let index = 0; index < take; index += 1) {
    const pick = index + Math.floor(rng() * (copy.length - index));
    const temp = copy[index];
    copy[index] = copy[pick];
    copy[pick] = temp;
  }
  return copy.slice(0, take).sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ */
/* Combinatoria                                                        */
/* ------------------------------------------------------------------ */

/** Coeficiente binomial exato (BigInt). */
export function binomial(n, k) {
  if (k < 0 || k > n) return 0n;
  const kk = BigInt(Math.min(k, n - k));
  let result = 1n;
  for (let index = 1n; index <= kk; index += 1n) {
    result = (result * (BigInt(n) - kk + index)) / index;
  }
  return result;
}

export function totalCombinations(profile, ticketSize) {
  const universeSize = profile.maxNumber - profile.minNumber + 1;
  return binomial(universeSize, ticketSize);
}

/** Gerador de combinacoes em ordem lexicografica. */
export function* combinations(elements, k) {
  const n = elements.length;
  if (k > n || k <= 0) return;
  const indices = Array.from({ length: k }, (_, index) => index);
  while (true) {
    yield indices.map((index) => elements[index]);
    let position = k - 1;
    while (position >= 0 && indices[position] === n - k + position) position -= 1;
    if (position < 0) return;
    indices[position] += 1;
    for (let index = position + 1; index < k; index += 1) indices[index] = indices[index - 1] + 1;
  }
}

/* ------------------------------------------------------------------ */
/* Filtros                                                             */
/* ------------------------------------------------------------------ */

export function createDefaultFilters(profile) {
  const universeSize = profile.maxNumber - profile.minNumber + 1;
  return {
    fixed: [],
    excluded: [],
    even: { min: 0, max: profile.drawSize },
    odd: { min: 0, max: profile.drawSize },
    sum: { min: profile.minNumber * profile.drawSize, max: profile.maxNumber * profile.drawSize },
    primes: { min: 0, max: universeSize },
    fibonacci: { min: 0, max: universeSize },
    repeat: { min: 0, max: profile.drawSize },
    maxSequence: { min: 1, max: profile.drawSize },
    lines: { min: 0, max: profile.board.rows },
    columns: { min: 0, max: profile.board.cols },
    frame: { min: 0, max: profile.drawSize },
    core: { min: 0, max: profile.drawSize },
    diversity: 0.55,
  };
}

function readRange(range, fallbackMin, fallbackMax) {
  const min = Number.isFinite(range?.min) ? range.min : fallbackMin;
  const max = Number.isFinite(range?.max) ? range.max : fallbackMax;
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

export function normalizeFilters(input, profile) {
  const defaults = createDefaultFilters(profile);
  const source = input && typeof input === 'object' ? input : {};
  const fixed = Array.isArray(source.fixed)
    ? [...new Set(source.fixed.filter((n) => Number.isInteger(n) && n >= profile.minNumber && n <= profile.maxNumber))].sort((a, b) => a - b)
    : [];
  const excluded = Array.isArray(source.excluded)
    ? [...new Set(source.excluded.filter((n) => Number.isInteger(n) && n >= profile.minNumber && n <= profile.maxNumber))].filter((n) => !fixed.includes(n))
    : [];

  return {
    fixed,
    excluded,
    even: readRange(source.even, defaults.even.min, defaults.even.max),
    odd: readRange(source.odd, defaults.odd.min, defaults.odd.max),
    sum: readRange(source.sum, defaults.sum.min, defaults.sum.max),
    primes: readRange(source.primes, 0, profile.drawSize),
    fibonacci: readRange(source.fibonacci, 0, profile.drawSize),
    repeat: readRange(source.repeat, 0, profile.drawSize),
    maxSequence: readRange(source.maxSequence, 1, profile.drawSize),
    lines: readRange(source.lines, 0, profile.board.rows),
    columns: readRange(source.columns, 0, profile.board.cols),
    frame: readRange(source.frame, 0, profile.drawSize),
    core: readRange(source.core, 0, profile.drawSize),
    diversity: Number.isFinite(source.diversity) ? clamp(source.diversity, 0, 1) : defaults.diversity,
  };
}

/** Valida a coerencia dos filtros antes de gerar. */
export function validateFilters(filters, profile, ticketSize) {
  const errors = [];
  if (filters.fixed.length > ticketSize) {
    errors.push(`dezenas fixas (${filters.fixed.length}) excedem o tamanho do jogo (${ticketSize})`);
  }
  if (filters.fixed.length + filters.excluded.length > profile.maxNumber - profile.minNumber + 1) {
    errors.push('fixas + excluidas esgotam o universo de dezenas');
  }
  if (filters.even.min + filters.odd.min > ticketSize) {
    errors.push('minimo de pares + minimo de impares excede o tamanho do jogo');
  }
  if (filters.sum.min > filters.sum.max) errors.push('soma minima maior que a maxima');
  return { valid: errors.length === 0, errors };
}

function longestSequenceOf(numbers) {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  let best = 1;
  let run = 1;
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1] + 1) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 1;
    }
  }
  return best;
}

/**
 * Avalia uma combinacao contra os filtros.
 * @returns {{ok:boolean, violations:Array<{key:string,label:string,expected:string,actual:number}>}}
 */
export function evaluateFilters(numbers, filters, context = {}) {
  const violations = [];
  const profile = context.profile;
  const metrics = context.metrics ?? structureFor(numbers, profile);
  const previous = context.previousDraw;

  const check = (key, label, value, range) => {
    if (value < range.min) {
      violations.push({ key, label, expected: `>= ${range.min}`, actual: value });
    } else if (value > range.max) {
      violations.push({ key, label, expected: `<= ${range.max}`, actual: value });
    }
  };

  check('even', 'Pares', metrics.even, filters.even);
  check('odd', 'Impares', metrics.odd, filters.odd);
  check('sum', 'Soma', metrics.sum, filters.sum);
  check('primes', 'Primos', metrics.primes, filters.primes);
  check('fibonacci', 'Fibonacci', metrics.fibonacci, filters.fibonacci);
  check('maxSequence', 'Sequencia maxima', metrics.longestSequence, filters.maxSequence);
  check('lines', 'Linhas usadas', metrics.rowsUsed, filters.lines);
  check('columns', 'Colunas usadas', metrics.colsUsed, filters.columns);
  check('frame', 'Moldura', metrics.frame, filters.frame);
  check('core', 'Miolo', metrics.core, filters.core);

  if (previous) {
    const previousSet = new Set(previous.numbers);
    const repeated = numbers.filter((number) => previousSet.has(number)).length;
    check('repeat', 'Repeticao', repeated, filters.repeat);
  }

  return { ok: violations.length === 0, violations };
}

/** Metricas estruturais sem dependencia do motor de score. */
export function structureFor(numbers, profile) {
  const frame = new Set(frameNumbers(profile));
  const core = new Set(coreNumbers(profile));
  const rows = new Set();
  const cols = new Set();
  let sumValue = 0;
  let even = 0;
  let primes = 0;
  let fibonacci = 0;
  let frameCount = 0;
  let coreCount = 0;
  for (const number of numbers) {
    sumValue += number;
    if (number % 2 === 0) even += 1;
    if (isPrime(profile, number)) primes += 1;
    if (isFibonacci(profile, number)) fibonacci += 1;
    if (frame.has(number)) frameCount += 1;
    if (core.has(number)) coreCount += 1;
    const cell = boardCell(profile, number);
    rows.add(cell.row);
    cols.add(cell.col);
  }
  return {
    sum: sumValue,
    even,
    odd: numbers.length - even,
    primes,
    fibonacci,
    frame: frameCount,
    core: coreCount,
    rowsUsed: rows.size,
    colsUsed: cols.size,
    longestSequence: longestSequenceOf(numbers),
  };
}

/* ------------------------------------------------------------------ */
/* Geracao                                                             */
/* ------------------------------------------------------------------ */

function availablePool(profile, filters) {
  const pool = [];
  const excluded = new Set(filters.excluded);
  for (let number = profile.minNumber; number <= profile.maxNumber; number += 1) {
    if (!excluded.has(number)) pool.push(number);
  }
  return pool;
}

/** Peso por frequencia historica (quente) ou inverso (frio). */
export function buildWeights(analysis, profile, mode = 'frequency') {
  const map = new Map();
  for (const item of analysis.frequency ?? []) map.set(item.number, item.count);
  const delayMap = new Map((analysis.delay?.perNumber ?? []).map((item) => [item.number, item.current]));
  const numbers = [];
  const weights = [];
  for (let number = profile.minNumber; number <= profile.maxNumber; number += 1) {
    const count = map.get(number) ?? 0;
    const delayValue = delayMap.get(number) ?? 0;
    let weight = 1;
    if (mode === 'hot') weight = 1 + count;
    else if (mode === 'cold') weight = 1 + Math.max(0, delayValue);
    else if (mode === 'balanced') weight = 1 + count * 0.5 + delayValue * 0.5;
    numbers.push(number);
    weights.push(weight);
  }
  return { numbers, weights };
}

/** Sorteio ponderado sem reposicao (chaves de Efraimidis-Spirakis). */
function weightedSample(candidateNumbers, candidateWeights, k, rng) {
  const keyed = candidateNumbers.map((number, index) => ({
    number,
    key: Math.log(Math.max(1e-12, rng())) / Math.max(1e-9, candidateWeights[index]),
  }));
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, k).map((item) => item.number).sort((a, b) => a - b);
}

function attemptCandidate(profile, size, filters, pool, rng, analysis, weightMode) {
  const fixed = filters.fixed;
  const needed = size - fixed.length;
  if (needed < 0) return null;

  const remainingPool = pool.filter((number) => !fixed.includes(number));
  if (remainingPool.length < needed) return null;

  let picked;
  if (weightMode && analysis) {
    const { numbers: allNumbers, weights: allWeights } = buildWeights(analysis, profile, weightMode);
    const weightByNumber = new Map(allNumbers.map((number, index) => [number, allWeights[index]]));
    picked = weightedSample(
      remainingPool,
      remainingPool.map((number) => weightByNumber.get(number) ?? 1),
      needed,
      rng,
    );
  } else {
    picked = sampleDistinct(remainingPool, needed, rng);
  }
  return [...fixed, ...picked].sort((a, b) => a - b);
}

/** Mutacao local: troca uma dezena nao fixa por outra fora do jogo. */
function mutate(candidate, fixedSet, pool, rng) {
  const movable = candidate.filter((number) => !fixedSet.has(number));
  if (movable.length === 0) return null;
  const inside = new Set(candidate);
  const outside = pool.filter((number) => !inside.has(number));
  if (outside.length === 0) return null;
  const remove = movable[Math.floor(rng() * movable.length)];
  const add = outside[Math.floor(rng() * outside.length)];
  return candidate
    .filter((number) => number !== remove)
    .concat(add)
    .sort((a, b) => a - b);
}

/**
 * Geracao com filtros.
 * Estrategia: amostragem + reparo por busca local com teto de tentativas.
 * Nunca enumera o espaco combinacional.
 */
export function generateFiltered(options) {
  const {
    profile,
    size,
    count,
    filters: rawFilters,
    analysis = null,
    rng,
    previousDraw = null,
    weightMode = null,
    maxAttempts = null,
    onProgress = null,
    isCancelled = null,
    diversity = null,
  } = options;

  const filters = normalizeFilters(rawFilters, profile);
  const check = validateFilters(filters, profile, size);
  if (!check.valid) {
    throw new Error(check.errors.join('; '));
  }
  if (!Number.isInteger(size) || size < profile.minTicketSize || size > profile.maxTicketSize) {
    throw new Error(`tamanho de jogo invalido: ${size}`);
  }
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`quantidade invalida: ${count}`);
  }

  const filterCount = countFilters(filters, profile, size);
  const attemptsLimit = maxAttempts ?? Math.min(2000000, Math.max(500, filterCount ? count * 400 : count * 20));
  const pool = availablePool(profile, filters);
  const fixedSet = new Set(filters.fixed);
  const context = { profile, previousDraw };
  const seen = new Map();
  const accepted = [];
  let attempts = 0;
  let rejectedByFilters = 0;

  while (accepted.length < count && attempts < attemptsLimit) {
    if (isCancelled && attempts % 64 === 0 && isCancelled()) {
      break;
    }
    attempts += 1;
    let candidate = attemptCandidate(profile, size, filters, pool, rng, analysis, weightMode);
    if (!candidate) break;

    let verdict = evaluateFilters(candidate, filters, context);
    if (!verdict.ok) {
      let current = candidate;
      let violations = verdict.violations.length;
      for (let step = 0; step < 24 && violations > 0; step += 1) {
        const mutated = mutate(current, fixedSet, pool, rng);
        if (!mutated) break;
        const nextVerdict = evaluateFilters(mutated, filters, context);
        if (nextVerdict.violations.length <= violations) {
          current = mutated;
          violations = nextVerdict.violations.length;
          verdict = nextVerdict;
        }
      }
      candidate = current;
    }

    if (!verdict.ok) {
      rejectedByFilters += 1;
      continue;
    }

    const key = candidate.join(',');
    if (seen.has(key)) continue;
    seen.set(key, true);
    accepted.push(candidate);

    if (onProgress && accepted.length % 25 === 0) {
      onProgress({ processed: accepted.length, total: count });
    }
  }

  const threshold = diversity ?? filters.diversity;
  const games = threshold > 0 ? selectDiverse(accepted.map((numbers) => ({ numbers })), count, threshold).map((item) => item.numbers) : accepted;

  return {
    games,
    requested: count,
    generated: games.length,
    attempts,
    rejectedByFilters,
    truncated: games.length < count,
    filtersApplied: filterCount > 0,
    diversity: threshold,
  };
}

function countFilters(filters, profile, size) {
  const defaults = normalizeFilters({}, profile);
  let total = 0;
  const compare = (range, base) => {
    if (range.min !== base.min || range.max !== base.max) total += 1;
  };
  compare(filters.even, defaults.even);
  compare(filters.odd, defaults.odd);
  compare(filters.sum, { min: profile.minNumber * size, max: profile.maxNumber * size });
  compare(filters.primes, { min: 0, max: size });
  compare(filters.fibonacci, { min: 0, max: size });
  compare(filters.repeat, { min: 0, max: size });
  compare(filters.maxSequence, { min: 1, max: size });
  compare(filters.lines, defaults.lines);
  compare(filters.columns, defaults.columns);
  compare(filters.frame, { min: 0, max: size });
  compare(filters.core, { min: 0, max: size });
  if (filters.fixed.length > 0) total += 1;
  if (filters.excluded.length > 0) total += 1;
  return total;
}

/** Geracao puramente aleatoria (sem filtros), com deduplicacao. */
export function generateRandom(options) {
  return generateFiltered({ ...options, filters: createDefaultFilters(options.profile), weightMode: null });
}

/**
 * Seleciona os melhores candidatos penalizando similaridade (Jaccard).
 * @param {Array<{numbers:number[], score?:number}>} candidates
 */
export function selectDiverse(candidates, count, threshold = 0.55) {
  const ordered = [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const selected = [];
  const fallback = [];
  for (const candidate of ordered) {
    if (selected.length >= count) break;
    let tooSimilar = false;
    for (const chosen of selected) {
      if (jaccardNumbers(candidate.numbers, chosen.numbers) >= threshold) {
        tooSimilar = true;
        break;
      }
    }
    if (tooSimilar) fallback.push(candidate);
    else selected.push(candidate);
  }
  for (const candidate of fallback) {
    if (selected.length >= count) break;
    selected.push(candidate);
  }
  return selected.slice(0, count);
}

function jaccardNumbers(a, b) {
  const setA = new Set(a);
  let intersection = 0;
  for (const number of b) if (setA.has(number)) intersection += 1;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Converte candidatos em bitmasks deduplicados. */
export function dedupe(candidates, profile) {
  const seen = new Map();
  const unique = [];
  for (const candidate of candidates) {
    const key = maskKey(encodeCombination(candidate, profile));
    if (seen.has(key)) continue;
    seen.set(key, true);
    unique.push(candidate);
  }
  return unique;
}

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

/**
 * Gera, pontua, deduplica, ordena e diversifica candidatos.
 * @returns {{games:Array, scanned:number, generated:number, truncated:boolean}}
 */
export function rankCandidates(options) {
  const { profile, analysis, weights = null, count = 10, candidateCount = null, ...rest } = options;
  const target = candidateCount ?? Math.min(20000, Math.max(count * 40, count));
  const generated = generateFiltered({ ...rest, profile, count: target, analysis });
  const unique = dedupe(generated.games, profile);
  const scored = scoreBatch(unique, analysis, profile, weights);
  const ranked = scored.sort((a, b) => b.score - a.score);
  const threshold = rest.diversity ?? rest.filters?.diversity ?? 0.55;
  const diverse = selectDiverse(ranked, count, threshold);
  return {
    games: diverse,
    scanned: generated.attempts,
    generated: unique.length,
    truncated: diverse.length < count,
    seedUsed: rest.seed ?? null,
    filters: generated.filtersApplied,
  };
}

/* ------------------------------------------------------------------ */
/* Estrategias                                                         */
/* ------------------------------------------------------------------ */

export const STRATEGIES = Object.freeze([
  { id: 'conservadora', label: 'Conservadora', description: 'Favorece dezenas de maior frequencia historica com estrutura central.' },
  { id: 'balanceada', label: 'Balanceada', description: 'Sem vies de frequencia: respeita apenas a estrutura central.' },
  { id: 'diversificada', label: 'Diversificada', description: 'Maximiza dissimilaridade entre os jogos gerados.' },
  { id: 'alta-frequencia', label: 'Alta frequencia', description: 'Pondera o sorteio pelas dezenas mais frequentes.' },
  { id: 'baixa-frequencia', label: 'Baixa frequencia', description: 'Pondera o sorteio pelas dezenas menos frequentes.' },
  { id: 'atraso', label: 'Atraso observado', description: 'Pondera pelas dezenas com maior atraso observado.' },
  { id: 'aleatoria', label: 'Aleatoria', description: 'Sorteio uniforme, sem filtros estruturais.' },
]);

/** Converte uma estrategia em parametros de geracao. */
export function strategyToOptions(strategyId, analysis, profile) {
  const stats = analysis ?? { frequency: [], delay: { perNumber: [] } };
  const centralFilters = () => {
    const filters = createDefaultFilters(profile);
    if (stats.sums?.stats?.band) {
      filters.sum = {
        min: Math.floor(stats.sums.stats.band.low),
        max: Math.ceil(stats.sums.stats.band.high),
      };
    }
    if (stats.parity?.stats?.band) {
      const evenLow = Math.max(0, Math.floor(stats.parity.stats.band.low));
      const evenHigh = Math.min(profile.drawSize, Math.ceil(stats.parity.stats.band.high));
      filters.even = { min: evenLow, max: evenHigh };
      filters.odd = { min: profile.drawSize - evenHigh, max: profile.drawSize - evenLow };
    }
    return filters;
  };

  switch (strategyId) {
    case 'conservadora':
      return { weightMode: 'hot', filters: centralFilters(), diversity: 0.45 };
    case 'alta-frequencia':
      return { weightMode: 'hot', filters: createDefaultFilters(profile), diversity: 0.5 };
    case 'baixa-frequencia':
      return { weightMode: 'cold', filters: createDefaultFilters(profile), diversity: 0.5 };
    case 'atraso':
      return { weightMode: 'cold', filters: createDefaultFilters(profile), diversity: 0.4 };
    case 'diversificada':
      return { weightMode: null, filters: centralFilters(), diversity: 0.2 };
    case 'aleatoria':
      return { weightMode: null, filters: createDefaultFilters(profile), diversity: 0 };
    case 'balanceada':
    default:
      return { weightMode: null, filters: centralFilters(), diversity: 0.5 };
  }
}

/* ------------------------------------------------------------------ */
/* Fechamento                                                          */
/* ------------------------------------------------------------------ */

/**
 * Fechamento: seleciona jogos a partir de um conjunto base de dezenas.
 * Cobertura reportada = pares do conjunto base presentes em ao menos um jogo.
 * Nao ha garantia de premiacao.
 */
export function generateClosure(options) {
  const { profile, base, size, maxGames = 50, rng, filters = null, diversity = 0 } = options;
  const baseNumbers = [...new Set(base)].filter(
    (number) => Number.isInteger(number) && number >= profile.minNumber && number <= profile.maxNumber,
  ).sort((a, b) => a - b);

  if (baseNumbers.length < size) {
    throw new Error(`conjunto base (${baseNumbers.length}) menor que o tamanho do jogo (${size})`);
  }
  const possible = binomial(baseNumbers.length, size);
  const target = Math.min(maxGames, Number(possible > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : possible));

  const games = [];
  const seen = new Set();
  if (possible <= BigInt(Math.max(target * 4, 5000))) {
    for (const combination of combinations(baseNumbers, size)) {
      if (games.length >= target) break;
      const sorted = combination.slice().sort((a, b) => a - b);
      const key = sorted.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      games.push(sorted);
    }
  } else {
    const limit = target * 60;
    let attempts = 0;
    const rngLocal = rng ?? createCryptoRng();
    while (games.length < target && attempts < limit) {
      attempts += 1;
      const candidate = sampleDistinct(baseNumbers, size, rngLocal);
      const key = candidate.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      games.push(candidate);
    }
  }

  const pairTotal = (baseNumbers.length * (baseNumbers.length - 1)) / 2;
  const pairSet = new Set();
  for (const game of games) {
    for (let index = 0; index < game.length; index += 1) {
      for (let other = index + 1; other < game.length; other += 1) {
        pairSet.add(`${game[index]}-${game[other]}`);
      }
    }
  }
  const coveredNumbers = new Set(games.flat());
  const filtered = filters
    ? games.filter((game) => evaluateFilters(game, normalizeFilters(filters, profile), { profile }).ok)
    : games;

  return {
    games: filtered,
    requested: maxGames,
    generated: filtered.length,
    totalPossible: possible.toString(),
    truncated: possible > BigInt(target),
    coverage: {
      pairsCovered: pairSet.size,
      pairsTotal: pairTotal,
      ratio: pairTotal ? roundTo(pairSet.size / pairTotal, 4) : 0,
      baseNumbersUsed: coveredNumbers.size,
      baseNumbersTotal: baseNumbers.length,
      numbersRatio: baseNumbers.length ? roundTo(coveredNumbers.size / baseNumbers.length, 4) : 0,
    },
    note: 'Cobertura historica de pares do conjunto base. Nao representa garantia de premiacao.',
  };
}

/* ------------------------------------------------------------------ */
/* Ferramentas auxiliares                                              */
/* ------------------------------------------------------------------ */

/** Converte texto (TXT/CSV) em jogos, ignorando linhas invalidas. */
export function parseGamesFromText(text, profile, separators = /[\s,;|]+/) {
  const games = [];
  const invalid = [];
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const tokens = trimmed.split(separators).filter(Boolean);
    const numbers = tokens.map((token) => Number.parseInt(token, 10)).filter((value) => Number.isInteger(value));
    if (numbers.length < profile.minTicketSize) {
      invalid.push({ line: index + 1, content: trimmed.slice(0, 120), reason: 'poucas dezenas' });
      return;
    }
    games.push([...new Set(numbers)].sort((a, b) => a - b));
  });
  return { games, invalid };
}
