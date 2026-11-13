/**
 * Motor de score.
 *
 * O score (0-100) mede ADERENCIA da combinacao aos criterios configurados,
 * comparando-a com o comportamento historico observado. Nao e probabilidade
 * de premiacao e nao antecipa o proximo sorteio.
 */

import { boardCell, coreNumbers, frameNumbers, isFibonacci, isPrime } from './game-profiles.js';
import { clamp, roundTo } from './statistics.js';

/** Estrutura interna de pesos: soma 1. Aceita qualquer entrada nao negativa. */
export function normalizeWeights(weights) {
  const base = weights && typeof weights === 'object' ? weights : {};
  const raw = {
    cycle: Math.max(0, Number(base.cycle) || 0),
    repetition: Math.max(0, Number(base.repetition) || 0),
    delay: Math.max(0, Number(base.delay) || 0),
    structure: Math.max(0, Number(base.structure) || 0),
  };
  const total = raw.cycle + raw.repetition + raw.delay + raw.structure;
  if (total <= 0) {
    return { cycle: 0.3, repetition: 0.25, delay: 0.2, structure: 0.25, normalized: false, total: 0 };
  }
  const scale = 100 / total;
  return {
    cycle: (raw.cycle * scale) / 100,
    repetition: (raw.repetition * scale) / 100,
    delay: (raw.delay * scale) / 100,
    structure: (raw.structure * scale) / 100,
    normalized: Math.abs(total - 100) > 0.001,
    total,
  };
}

/** 100 quando z = 0, decai conforme o afastamento em unidades de sigma. */
function gaussianScore(z, sigma = 1) {
  const scaled = z / (sigma || 1);
  return 100 * Math.exp(-0.5 * scaled * scaled);
}

/** Aproximacao linear: 100 dentro da faixa, decai fora dela. */
function bandScore(value, stats, tolerance = null) {
  if (!stats) return 50;
  const half = Math.max(0.5, (stats.band.high - stats.band.low) / 2);
  const size = tolerance ?? half;
  if (value >= stats.band.low - 0.5 && value <= stats.band.high + 0.5) return 100;
  const distance = value > stats.band.high ? value - stats.band.high : stats.band.low - value;
  return 100 * Math.exp(-0.5 * (distance / Math.max(0.5, size)) ** 2);
}

/* ------------------------------------------------------------------ */
/* Metricas estruturais de uma combinacao                              */
/* ------------------------------------------------------------------ */

export function structureMetrics(numbers, profile) {
  const sorted = [...numbers].sort((a, b) => a - b);
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

  for (const number of sorted) {
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

  let longest = 1;
  let run = 1;
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1] + 1) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 1;
    }
  }

  return {
    count: sorted.length,
    sum: sumValue,
    even,
    odd: sorted.length - even,
    primes,
    fibonacci,
    longestSequence: sorted.length ? longest : 0,
    rowsUsed: rows.size,
    colsUsed: cols.size,
    frame: frameCount,
    core: coreCount,
    mean: sorted.length ? roundTo(sumValue / sorted.length, 2) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Componentes                                                         */
/* ------------------------------------------------------------------ */

function cycleComponent(numbers, analysis, profile) {
  const absent = new Set(analysis.cycle?.absent ?? []);
  const absentCount = numbers.filter((number) => absent.has(number)).length;
  const share = numbers.length ? absentCount / numbers.length : 0;
  const progress = clamp(analysis.cycle?.progress ?? 0, 0, 1);
  const buckets = analysis.cycleNewShare?.byBucket ?? [];
  const bucketIndex = clamp(Math.floor(progress * buckets.length), 0, Math.max(0, buckets.length - 1));
  const bucket = buckets[bucketIndex];
  const fallback = buckets.reduce(
    (acc, item) => {
      if (!item.samples) return acc;
      return { samples: acc.samples + item.samples, weighted: acc.weighted + item.meanShare * item.samples };
    },
    { samples: 0, weighted: 0 },
  );
  const expected = bucket && bucket.samples >= 5 ? bucket.meanShare : fallback.samples ? fallback.weighted / fallback.samples : 0.3;

  const tolerance = Math.max(0.18, expected * 0.75);
  const score = 100 * clamp(1 - Math.abs(share - expected) / tolerance, 0, 1);
  const expectedCount = roundTo(expected * numbers.length, 1);

  const reasons = [];
  const warnings = [];
  if (absentCount > 0) {
    reasons.push(
      `${absentCount} dezena(s) ainda ausente(s) no ciclo observado (referencia historica para este estagio: ~${expectedCount} de ${numbers.length}).`,
    );
  } else {
    reasons.push('Nenhuma dezena ausente no ciclo atual foi utilizada.');
  }
  if (analysis.cycle?.coverage !== undefined) {
    reasons.push(
      `Cobertura atual do ciclo: ${roundTo(analysis.cycle.coverage * 100, 1)}% (${analysis.cycle.seen.length} de ${profile.maxNumber - profile.minNumber + 1} dezenas vistas).`,
    );
  }
  if (score < 45) {
    warnings.push('Proporcao de dezenas ausentes no ciclo fora do padrao historico para o estagio atual.');
  }

  return {
    score: roundTo(score, 2),
    detail: {
      absentCount,
      share: roundTo(share, 4),
      expected: roundTo(expected, 4),
      expectedCount,
      progress: roundTo(progress, 4),
    },
    reasons,
    warnings,
  };
}

function repetitionComponent(numbers, analysis) {
  const previous = analysis.lastDraw;
  if (!previous) {
    return {
      score: 50,
      detail: { repeated: null, mean: null, band: null },
      reasons: ['Sem concurso anterior disponivel para comparar repeticao.'],
      warnings: [],
    };
  }
  const previousSet = new Set(previous.numbers);
  const repeated = numbers.filter((number) => previousSet.has(number)).length;
  const stats = analysis.repetition?.stats;
  const meanValue = stats?.mean ?? 0;
  const std = Math.max(0.75, stats?.std ?? 1);
  const score = stats ? gaussianScore(repeated - meanValue, std) : 50;

  const reasons = [
    `${repeated} dezena(s) coincidem com o concurso ${previous.contest}: media historica ${roundTo(meanValue, 2)} (faixa central ${stats?.band?.low ?? '-'} a ${stats?.band?.high ?? '-'}).`,
  ];
  const warnings = [];
  if (score < 45) {
    warnings.push('Quantidade de repeticao distante do padrao historico observado.');
  }
  return {
    score: roundTo(score, 2),
    detail: {
      repeated,
      mean: roundTo(meanValue, 2),
      band: stats?.band ?? null,
      previousContest: previous.contest,
    },
    reasons,
    warnings,
  };
}

function delayComponent(numbers, analysis) {
  const perNumber = analysis.delay?.perNumber ?? [];
  if (perNumber.length === 0) {
    return {
      score: 50,
      detail: { meanZ: 0, meanDelay: 0 },
      reasons: ['Sem historico de atraso disponivel.'],
      warnings: [],
    };
  }
  const lookup = new Map(perNumber.map((item) => [item.number, item]));
  let zTotal = 0;
  let delayTotal = 0;
  let counted = 0;
  let maxDelay = 0;
  let maxDelayNumber = null;
  for (const number of numbers) {
    const item = lookup.get(number);
    if (!item) continue;
    zTotal += item.zScore ?? 0;
    delayTotal += item.current;
    counted += 1;
    if (item.current > maxDelay) {
      maxDelay = item.current;
      maxDelayNumber = number;
    }
  }
  const meanZ = counted ? zTotal / counted : 0;
  const meanDelay = counted ? delayTotal / counted : 0;
  const score = gaussianScore(meanZ, 1.6);

  const reasons = [
    `Atraso medio observado das dezenas escolhidas: ${roundTo(meanDelay, 2)} concursos (media teorica de referencia: ${analysis.delayExpected}).`,
  ];
  if (maxDelayNumber !== null) {
    reasons.push(`Maior atraso no conjunto: dezena ${maxDelayNumber} ausente ha ${maxDelay} concursos.`);
  }
  return {
    score: roundTo(score, 2),
    detail: {
      meanZ: roundTo(meanZ, 3),
      meanDelay: roundTo(meanDelay, 2),
      maxDelay,
      maxDelayNumber,
      expectedDelay: analysis.delayExpected,
    },
    reasons,
    warnings: [
      'Atraso e registro historico: nao aumenta nem diminui a chance real de um sorteio futuro.',
    ],
    note: 'atraso',
  };
}

function structureComponent(numbers, profile, analysis) {
  const metrics = structureMetrics(numbers, profile);
  const subs = [
    {
      key: 'sum',
      label: 'Soma',
      value: metrics.sum,
      stats: analysis.sums?.stats,
      weight: 0.3,
      format: (value) => String(value),
    },
    {
      key: 'even',
      label: 'Pares',
      value: metrics.even,
      stats: analysis.parity?.stats,
      weight: 0.2,
      format: (value) => String(value),
    },
    {
      key: 'odd',
      label: 'Impares',
      value: metrics.odd,
      stats: analysis.parity?.oddStats,
      weight: 0,
      format: (value) => String(value),
    },
    {
      key: 'primes',
      label: 'Primos',
      value: metrics.primes,
      stats: analysis.primes?.stats,
      weight: 0.1,
      format: (value) => String(value),
    },
    {
      key: 'fibonacci',
      label: 'Fibonacci',
      value: metrics.fibonacci,
      stats: analysis.fibonacci?.stats,
      weight: 0.05,
      format: (value) => String(value),
    },
    {
      key: 'sequences',
      label: 'Sequencias',
      value: metrics.longestSequence,
      stats: analysis.sequences?.stats,
      weight: 0.15,
      format: (value) => `${value}x`,
    },
    {
      key: 'spread',
      label: 'Linhas/colunas',
      value: metrics.rowsUsed + metrics.colsUsed,
      stats: null,
      weight: 0.1,
      format: (value) => String(value),
    },
    {
      key: 'frame',
      label: 'Moldura',
      value: metrics.frame,
      stats: analysis.frame?.stats,
      weight: 0.1,
      format: (value) => String(value),
    },
  ];

  // "spread" nao possui serie propria: deriva das estatisticas de linhas e colunas.
  const spreadTarget = {
    band: {
      low: (analysis.lines?.used?.band?.low ?? 0) + (analysis.columns?.used?.band?.low ?? 0),
      high: (analysis.lines?.used?.band?.high ?? 0) + (analysis.columns?.used?.band?.high ?? 0),
    },
  };
  subs[6].stats = spreadTarget;

  let weighted = 0;
  let weightTotal = 0;
  const breakdown = [];
  for (const sub of subs) {
    if (sub.weight <= 0) continue;
    const score = bandScore(sub.value, sub.stats);
    weighted += score * sub.weight;
    weightTotal += sub.weight;
    breakdown.push({
      key: sub.key,
      label: sub.label,
      value: sub.value,
      formatted: sub.format(sub.value),
      target: sub.stats?.band ?? null,
      score: roundTo(score, 2),
      weight: sub.weight,
    });
  }

  const score = weightTotal > 0 ? weighted / weightTotal : 50;
  const reasons = [];
  const warnings = [];

  const sumDetail = breakdown.find((item) => item.key === 'sum');
  if (sumDetail?.target) {
    const inside = metrics.sum >= sumDetail.target.low && metrics.sum <= sumDetail.target.high;
    reasons.push(
      `Soma ${metrics.sum} ${inside ? 'esta dentro' : 'esta fora'} da faixa central historica (${sumDetail.target.low} a ${sumDetail.target.high}).`,
    );
  }
  reasons.push(`Paridade: ${metrics.even} pares / ${metrics.odd} impares.`);
  if (metrics.longestSequence > 1) {
    reasons.push(`Maior sequencia consecutiva: ${metrics.longestSequence} dezenas.`);
  }

  for (const item of breakdown) {
    if (item.score < 35) {
      warnings.push(
        `${item.label} (${item.formatted}) fora da faixa central historica${item.target ? ` (${item.target.low} a ${item.target.high})` : ''}.`,
      );
    }
  }

  return {
    score: roundTo(score, 2),
    detail: { metrics, breakdown },
    reasons,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Score final                                                         */
/* ------------------------------------------------------------------ */

/**
 * @param {number[]} numbers
 * @param {object} analysis resultado de analyzeDataset
 * @param {object} profile
 * @param {{cycle:number,repetition:number,delay:number,structure:number}} [weights]
 */
export function computeScore(numbers, analysis, profile, weights = null) {
  const normalized = normalizeWeights(weights);
  const cycle = cycleComponent(numbers, analysis, profile);
  const repetition = repetitionComponent(numbers, analysis);
  const delay = delayComponent(numbers, analysis);
  const structure = structureComponent(numbers, profile, analysis);

  const score =
    cycle.score * normalized.cycle +
    repetition.score * normalized.repetition +
    delay.score * normalized.delay +
    structure.score * normalized.structure;

  return {
    score: roundTo(score, 2),
    components: {
      cycle: cycle.score,
      repetition: repetition.score,
      delay: delay.score,
      structure: structure.score,
    },
    weights: {
      cycle: roundTo(normalized.cycle * 100, 2),
      repetition: roundTo(normalized.repetition * 100, 2),
      delay: roundTo(normalized.delay * 100, 2),
      structure: roundTo(normalized.structure * 100, 2),
    },
    weightsNormalized: normalized.normalized,
    details: {
      cycle: cycle.detail,
      repetition: repetition.detail,
      delay: delay.detail,
      structure: structure.detail,
    },
    reasons: [...cycle.reasons, ...repetition.reasons, ...delay.reasons, ...structure.reasons],
    warnings: [
      ...cycle.warnings,
      ...repetition.warnings,
      ...structure.warnings,
      'Score mede aderencia aos criterios escolhidos; nao representa probabilidade de premio.',
    ],
    heuristic: true,
  };
}

/** Score em lote, reaproveitando a analise (usado no ranking do Worker). */
export function scoreBatch(candidates, analysis, profile, weights = null) {
  const normalized = normalizeWeights(weights);
  return candidates.map((numbers) => {
    const cycle = cycleComponent(numbers, analysis, profile);
    const repetition = repetitionComponent(numbers, analysis);
    const delay = delayComponent(numbers, analysis);
    const structure = structureComponent(numbers, profile, analysis);
    const score =
      cycle.score * normalized.cycle +
      repetition.score * normalized.repetition +
      delay.score * normalized.delay +
      structure.score * normalized.structure;
    return {
      numbers,
      score: roundTo(score, 2),
      components: {
        cycle: cycle.score,
        repetition: repetition.score,
        delay: delay.score,
        structure: structure.score,
      },
      reasons: [...cycle.reasons, ...repetition.reasons, ...structure.reasons],
      warnings: [...cycle.warnings, ...repetition.warnings, ...structure.warnings],
      details: { cycle: cycle.detail, repetition: repetition.detail, delay: delay.detail, structure: structure.detail },
    };
  });
}

export { bandScore, gaussianScore };
