/**
 * Estatistica descritiva e analise estrutural.
 * Funcoes puras: nenhuma dependencia de DOM, IndexedDB ou Worker.
 * Todo resultado descreve COMPORTAMENTO HISTORICO observado, nunca previsao.
 */

import { boardCell, coreNumbers, frameNumbers, isFibonacci, isPrime } from './game-profiles.js';

/* ------------------------------------------------------------------ */
/* Utilitarios numericos                                               */
/* ------------------------------------------------------------------ */

export function sum(values) {
  let total = 0;
  for (let index = 0; index < values.length; index += 1) total += values[index];
  return total;
}

export function mean(values) {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function variance(values, sample = true) {
  if (values.length === 0) return 0;
  if (values.length === 1) return 0;
  const avg = mean(values);
  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    const delta = values[index] - avg;
    total += delta * delta;
  }
  return total / (sample ? values.length - 1 : values.length);
}

export function stdDev(values, sample = true) {
  return Math.sqrt(variance(values, sample));
}

/** Percentil por interpolacao linear (p entre 0 e 1). */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const clamped = Math.min(1, Math.max(0, p));
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * clamped;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function minOf(values) {
  return values.length === 0 ? 0 : Math.min(...values);
}

export function maxOf(values) {
  return values.length === 0 ? 0 : Math.max(...values);
}

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function roundTo(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Distribuicao de frequencia de valores discretos. */
export function distribution(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => ({ value, count, relative: values.length ? count / values.length : 0 }));
}

/**
 * Resumo estatistico de uma serie, incluindo faixa central historica (p10-p90).
 */
export function summarizeSeries(values) {
  if (values.length === 0) {
    return {
      count: 0,
      mean: 0,
      median: 0,
      std: 0,
      min: 0,
      max: 0,
      p10: 0,
      p90: 0,
      band: { low: 0, high: 0 },
      distribution: [],
    };
  }
  const p10 = percentile(values, 0.1);
  const p90 = percentile(values, 0.9);
  return {
    count: values.length,
    mean: roundTo(mean(values), 3),
    median: roundTo(median(values), 3),
    std: roundTo(stdDev(values), 3),
    min: minOf(values),
    max: maxOf(values),
    p10: roundTo(p10, 3),
    p90: roundTo(p90, 3),
    band: { low: roundTo(p10, 2), high: roundTo(p90, 2) },
    distribution: distribution(values),
  };
}

/* ------------------------------------------------------------------ */
/* Funcoes gama / chi-quadrado (para aderencia de distribuicao)        */
/* ------------------------------------------------------------------ */

function lnGamma(x) {
  const coefficients = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const coefficient of coefficients) {
    y += 1;
    ser += coefficient / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function gammaSeries(a, x) {
  let apos = a;
  let sumValue = 1 / a;
  let del = sumValue;
  for (let n = 0; n < 200; n += 1) {
    apos += 1;
    del *= x / apos;
    sumValue += del;
    if (Math.abs(del) < Math.abs(sumValue) * 1e-12) break;
  }
  return sumValue * Math.exp(-x + a * Math.log(x) - lnGamma(a));
}

function gammaContinuedFraction(a, x) {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 200; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/** Probabilidade de cauda superior da distribuicao chi-quadrado. */
export function chiSquarePValue(statistic, degreesOfFreedom) {
  if (!(statistic > 0) || degreesOfFreedom <= 0) return 1;
  const a = degreesOfFreedom / 2;
  const x = statistic / 2;
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
}

/** Teste de aderencia da frequencia das dezenas contra a hipotese uniforme. */
export function frequencyChiSquare(freq, totalDraws, drawSize, universeSize) {
  if (totalDraws === 0) return { statistic: 0, df: 0, pValue: 1, expected: 0 };
  const expected = (totalDraws * drawSize) / universeSize;
  let statistic = 0;
  for (const item of freq) {
    const delta = item.count - expected;
    statistic += (delta * delta) / expected;
  }
  const df = Math.max(1, freq.length - 1);
  return {
    statistic: roundTo(statistic, 3),
    df,
    pValue: roundTo(chiSquarePValue(statistic, df), 4),
    expected: roundTo(expected, 3),
  };
}

/* ------------------------------------------------------------------ */
/* Estatisticas por dezena                                             */
/* ------------------------------------------------------------------ */

/** Frequencia absoluta e relativa de cada dezena. */
export function frequency(draws, profile) {
  const counts = new Map();
  for (let number = profile.minNumber; number <= profile.maxNumber; number += 1) counts.set(number, 0);
  for (const draw of draws) {
    for (const number of draw.numbers) {
      counts.set(number, (counts.get(number) ?? 0) + 1);
    }
  }
  const totalAppearances = draws.length * profile.drawSize;
  return [...counts.entries()].map(([number, count]) => ({
    number,
    count,
    relative: totalAppearances ? count / totalAppearances : 0,
    expected: totalAppearances ? profile.drawSize / (profile.maxNumber - profile.minNumber + 1) : 0,
  }));
}

/** Frequencia relativa apenas. */
export function relativeFrequency(draws, profile) {
  return frequency(draws, profile).map((item) => ({ number: item.number, relative: item.relative }));
}

/**
 * Atraso (delay) de cada dezena: quantidade de concursos desde a ultima aparicao.
 * 0 significa que a dezena saiu no concurso mais recente.
 */
export function delay(draws, profile) {
  const lastIndex = new Map();
  const gaps = new Map();
  for (let number = profile.minNumber; number <= profile.maxNumber; number += 1) {
    lastIndex.set(number, -1);
    gaps.set(number, []);
  }

  draws.forEach((draw, index) => {
    const present = new Set(draw.numbers);
    for (let number = profile.minNumber; number <= profile.maxNumber; number += 1) {
      if (present.has(number)) {
        const previous = lastIndex.get(number);
        if (previous >= 0) gaps.get(number).push(index - previous);
        lastIndex.set(number, index);
      }
    }
  });

  const lastDrawIndex = draws.length - 1;
  return {
    perNumber: [...lastIndex.entries()].map(([number, index]) => {
      const history = gaps.get(number);
      const current = index < 0 ? draws.length : lastDrawIndex - index;
      const avg = history.length ? mean(history) : 0;
      const deviation = history.length > 1 ? stdDev(history) : 0;
      return {
        number,
        current,
        mean: roundTo(avg, 3),
        max: history.length ? maxOf(history) : 0,
        gaps: history.length,
        std: roundTo(deviation, 3),
        zScore: roundTo(deviation > 0 ? (current - avg) / deviation : 0, 3),
        neverDrawn: index < 0,
      };
    }),
    mean: roundTo(
      mean([...lastIndex.values()].filter((index) => index >= 0).map((index) => lastDrawIndex - index)),
      3,
    ),
  };
}

export function averageDelay(draws, profile) {
  return delay(draws, profile).perNumber;
}

/** Atraso medio teorico esperado (1 tentativa por concurso, sem reposicao). */
export function expectedDelay(profile) {
  return (profile.maxNumber - profile.minNumber + 1) / profile.drawSize;
}

export function delayZScore(draws, profile) {
  return delay(draws, profile).perNumber.map((item) => ({ number: item.number, zScore: item.zScore }));
}

/* ------------------------------------------------------------------ */
/* Series estruturais por concurso                                     */
/* ------------------------------------------------------------------ */

export function sumSeries(draws) {
  return draws.map((draw) => sum(draw.numbers));
}

export function paritySeries(draws, profile) {
  return draws.map((draw) => ({
    contest: draw.contest,
    even: draw.numbers.filter((number) => number % 2 === 0).length,
    odd: draw.numbers.filter((number) => number % 2 !== 0).length,
    total: profile.drawSize,
  }));
}

export function primeSeries(draws, profile) {
  return draws.map((draw) => ({
    contest: draw.contest,
    primes: draw.numbers.filter((number) => isPrime(profile, number)).length,
  }));
}

export function fibonacciSeries(draws, profile) {
  return draws.map((draw) => ({
    contest: draw.contest,
    fibonacci: draw.numbers.filter((number) => isFibonacci(profile, number)).length,
  }));
}

/** Maior sequencia de dezenas consecutivas dentro do concurso. */
export function longestSequence(numbers) {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  let best = 1;
  let current = 1;
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1] + 1) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 1;
    }
  }
  return best;
}

export function sequenceSeries(draws) {
  return draws.map((draw) => ({
    contest: draw.contest,
    longest: longestSequence(draw.numbers),
  }));
}

export function lineSeries(draws, profile) {
  const cells = draws.map((draw) => draw.numbers.map((number) => boardCell(profile, number)));
  return cells.map((list, index) => {
    const rows = new Set(list.map((cell) => cell.row));
    const perRow = new Array(profile.board.rows).fill(0);
    for (const cell of list) perRow[cell.row] += 1;
    return {
      contest: draws[index].contest,
      rowsUsed: rows.size,
      maxPerRow: Math.max(...perRow, 0),
      distribution: perRow,
    };
  });
}

export function columnSeries(draws, profile) {
  const cells = draws.map((draw) => draw.numbers.map((number) => boardCell(profile, number)));
  return cells.map((list, index) => {
    const cols = new Set(list.map((cell) => cell.col));
    const perCol = new Array(profile.board.cols).fill(0);
    for (const cell of list) perCol[cell.col] += 1;
    return {
      contest: draws[index].contest,
      colsUsed: cols.size,
      maxPerCol: Math.max(...perCol, 0),
      distribution: perCol,
    };
  });
}

export function frameSeries(draws, profile) {
  const frame = new Set(frameNumbers(profile));
  return draws.map((draw) => ({
    contest: draw.contest,
    frame: draw.numbers.filter((number) => frame.has(number)).length,
  }));
}

export function coreSeries(draws, profile) {
  const core = new Set(coreNumbers(profile));
  return draws.map((draw) => ({
    contest: draw.contest,
    core: draw.numbers.filter((number) => core.has(number)).length,
  }));
}

/** Repeticao em relacao ao concurso imediatamente anterior. */
export function repetitionSeries(draws) {
  const series = [];
  for (let index = 1; index < draws.length; index += 1) {
    const previous = new Set(draws[index - 1].numbers);
    const repeated = draws[index].numbers.filter((number) => previous.has(number)).length;
    series.push({ contest: draws[index].contest, repeated });
  }
  return series;
}

/** Contagem espacial por celula do volante. */
export function spatialAnalysis(draws, profile) {
  const counts = new Map();
  for (let number = profile.minNumber; number <= profile.maxNumber; number += 1) {
    counts.set(number, 0);
  }
  for (const draw of draws) {
    for (const number of draw.numbers) counts.set(number, counts.get(number) + 1);
  }
  const totalAppearances = draws.length * profile.drawSize;
  const cells = [];
  for (const [number, count] of counts.entries()) {
    const cell = boardCell(profile, number);
    cells.push({
      number,
      row: cell.row,
      col: cell.col,
      count,
      share: roundTo(count / (totalAppearances || 1), 4),
    });
  }
  const sorted = [...cells].sort((a, b) => b.count - a.count);
  return { cells, hottest: sorted.slice(0, 5), coldest: sorted.slice(-5).reverse() };
}

/* ------------------------------------------------------------------ */
/* Ciclo                                                               */
/* ------------------------------------------------------------------ */

/**
 * Ciclo observado: conjunto de concursos necessarios para que todas as dezenas
 * do universo aparecam ao menos uma vez. Nao e previsao — e agrupamento historico.
 */
export function cycleAnalysis(draws, profile) {
  const universeSize = profile.maxNumber - profile.minNumber + 1;
  const completed = [];
  let seen = new Set();
  let cycleStart = 0;

  draws.forEach((draw, index) => {
    for (const number of draw.numbers) seen.add(number);
    if (seen.size >= universeSize) {
      completed.push({ startContest: draws[cycleStart]?.contest ?? null, endContest: draw.contest, length: index - cycleStart + 1 });
      cycleStart = index + 1;
      seen = new Set();
    }
  });

  const currentStartIndex = cycleStart;
  const currentDraws = draws.slice(currentStartIndex);
  const seenNow = new Set();
  for (const draw of currentDraws) for (const number of draw.numbers) seenNow.add(number);

  const absent = [];
  const present = [];
  for (let number = profile.minNumber; number <= profile.maxNumber; number += 1) {
    (seenNow.has(number) ? present : absent).push(number);
  }

  const lengths = completed.map((cycle) => cycle.length);
  const meanCycleLength = lengths.length ? mean(lengths) : expectedDelay(profile);
  const coverage = present.length / universeSize;
  const progress = meanCycleLength > 0 ? currentDraws.length / meanCycleLength : 0;

  return {
    cyclesCompleted: completed.length,
    lastCompleted: completed.length ? completed[completed.length - 1] : null,
    meanCycleLength: roundTo(meanCycleLength, 2),
    medianCycleLength: roundTo(median(lengths), 2),
    minCycleLength: lengths.length ? minOf(lengths) : 0,
    maxCycleLength: lengths.length ? maxOf(lengths) : 0,
    cycleStartContest: draws[currentStartIndex]?.contest ?? null,
    drawsInCycle: currentDraws.length,
    seen: present,
    absent,
    coverage: roundTo(coverage, 4),
    progress: roundTo(progress, 4),
    estimatedRemaining: Math.max(0, roundTo(meanCycleLength - currentDraws.length, 1)),
    completed,
  };
}

/**
 * Serie de "dezenas novas no ciclo" por concurso, agrupada por estagio do ciclo.
 * Usada para comparar uma combinacao com o comportamento historico no mesmo estagio.
 */
export function cycleNewShareSeries(draws, profile) {
  const universeSize = profile.maxNumber - profile.minNumber + 1;
  const series = [];
  let seen = new Set();
  let cycleIndex = 0;
  let cycleLength = 0;

  for (const draw of draws) {
    const fresh = draw.numbers.filter((number) => !seen.has(number)).length;
    series.push({ contest: draw.contest, fresh, share: fresh / profile.drawSize, cycleIndex, cycleLength });
    for (const number of draw.numbers) seen.add(number);
    cycleLength += 1;
    if (seen.size >= universeSize) {
      seen = new Set();
      cycleIndex += 1;
      cycleLength = 0;
    }
  }
  return series;
}

/* ------------------------------------------------------------------ */
/* Analise agregada                                                    */
/* ------------------------------------------------------------------ */

function seriesStats(series, key) {
  return summarizeSeries(series.map((item) => item[key]));
}

/**
 * Analise completa de um dataset.
 * @param {Array<{contest:number,date:string,numbers:number[]}>} draws concursos ordenados
 * @param {object} profile GAME_PROFILE
 * @param {{window?: number, maxDraws?: number}} [options]
 */
export function analyzeDataset(draws, profile, options = {}) {
  const limited =
    Number.isInteger(options.maxDraws) && options.maxDraws > 0 ? draws.slice(-options.maxDraws) : draws;
  const used = limited.length > 0 ? limited : [];

  if (used.length === 0) {
    return emptyAnalysis(profile);
  }

  const freq = frequency(used, profile);
  const delayInfo = delay(used, profile);
  const repetition = repetitionSeries(used);
  const sums = sumSeries(used);
  const parity = paritySeries(used, profile);
  const primes = primeSeries(used, profile);
  const fibonacci = fibonacciSeries(used, profile);
  const sequences = sequenceSeries(used);
  const lines = lineSeries(used, profile);
  const columns = columnSeries(used, profile);
  const frame = frameSeries(used, profile);
  const core = coreSeries(used, profile);
  const cycle = cycleAnalysis(used, profile);
  const cycleNew = cycleNewShareSeries(used, profile);
  const spatial = spatialAnalysis(used, profile);

  const bucketCount = 5;
  const buckets = Array.from({ length: bucketCount }, () => []);
  for (const item of cycleNew) {
    if (!(cycle.meanCycleLength > 0)) {
      buckets[0].push(item.share);
      continue;
    }
    const position = item.cycleLength / cycle.meanCycleLength;
    const bucket = clamp(Math.floor(position * bucketCount), 0, bucketCount - 1);
    buckets[bucket].push(item.share);
  }
  const newShareByBucket = buckets.map((values, bucket) => ({
    bucket,
    samples: values.length,
    meanShare: roundTo(values.length ? mean(values) : 0, 4),
  }));

  const totalDraws = used.length;
  const universeSize = profile.maxNumber - profile.minNumber + 1;

  return {
    game: profile.id,
    profileId: profile.id,
    totalDraws,
    firstContest: used[0].contest,
    lastContest: used[used.length - 1].contest,
    firstDate: used[0].date,
    lastDate: used[used.length - 1].date,
    window: totalDraws,
    frequency: freq,
    frequencySummary: {
      max: freq.reduce((best, item) => (item.count > best.count ? item : best), freq[0]),
      min: freq.reduce((worst, item) => (item.count < worst.count ? item : worst), freq[0]),
      mean: roundTo(mean(freq.map((item) => item.count)), 2),
      chiSquare: frequencyChiSquare(freq, totalDraws, profile.drawSize, universeSize),
    },
    delay: delayInfo,
    delayExpected: roundTo(expectedDelay(profile), 3),
    repetition: {
      series: repetition,
      stats: seriesStats(repetition, 'repeated'),
      lastDrawRepeated: repetition.length ? repetition[repetition.length - 1].repeated : 0,
    },
    sums: {
      series: sums,
      stats: summarizeSeries(sums),
      meanPerDraw: roundTo(mean(sums), 2),
      theoretical: roundTo(((profile.minNumber + profile.maxNumber) * profile.drawSize) / 2, 2),
    },
    parity: {
      series: parity,
      stats: seriesStats(parity, 'even'),
      oddStats: seriesStats(parity, 'odd'),
    },
    primes: { series: primes, stats: seriesStats(primes, 'primes') },
    fibonacci: { series: fibonacci, stats: seriesStats(fibonacci, 'fibonacci') },
    sequences: { series: sequences, stats: seriesStats(sequences, 'longest') },
    lines: {
      series: lines,
      used: seriesStats(lines, 'rowsUsed'),
      maxPerLine: seriesStats(lines, 'maxPerRow'),
    },
    columns: {
      series: columns,
      used: seriesStats(columns, 'colsUsed'),
      maxPerColumn: seriesStats(columns, 'maxPerCol'),
    },
    frame: { series: frame, stats: seriesStats(frame, 'frame') },
    core: { series: core, stats: seriesStats(core, 'core') },
    cycle,
    cycleNewShare: { series: cycleNew, byBucket: newShareByBucket },
    spatial,
    lastDraw: used[used.length - 1],
    previousDraw: used.length > 1 ? used[used.length - 2] : null,
    generatedAt: new Date().toISOString(),
  };
}

export function emptyAnalysis(profile) {
  const stats = summarizeSeries([]);
  return {
    game: profile.id,
    profileId: profile.id,
    totalDraws: 0,
    firstContest: null,
    lastContest: null,
    firstDate: null,
    lastDate: null,
    window: 0,
    frequency: [],
    frequencySummary: { max: null, min: null, mean: 0, chiSquare: { statistic: 0, df: 0, pValue: 1, expected: 0 } },
    delay: { perNumber: [], mean: 0 },
    delayExpected: roundTo(expectedDelay(profile), 3),
    repetition: { series: [], stats, lastDrawRepeated: 0 },
    sums: { series: [], stats, meanPerDraw: 0, theoretical: 0 },
    parity: { series: [], stats, oddStats: stats },
    primes: { series: [], stats },
    fibonacci: { series: [], stats },
    sequences: { series: [], stats },
    lines: { series: [], used: stats, maxPerLine: stats },
    columns: { series: [], used: stats, maxPerColumn: stats },
    frame: { series: [], stats },
    core: { series: [], stats },
    cycle: {
      cyclesCompleted: 0,
      lastCompleted: null,
      meanCycleLength: roundTo(expectedDelay(profile), 2),
      medianCycleLength: 0,
      minCycleLength: 0,
      maxCycleLength: 0,
      cycleStartContest: null,
      drawsInCycle: 0,
      seen: [],
      absent: [],
      coverage: 0,
      progress: 0,
      estimatedRemaining: 0,
      completed: [],
    },
    cycleNewShare: { series: [], byBucket: [] },
    spatial: { cells: [], hottest: [], coldest: [] },
    lastDraw: null,
    previousDraw: null,
    generatedAt: new Date().toISOString(),
  };
}

/** Distribuicao de acertos de um conjunto de jogos contra todos os concursos. */
export function hitsDistribution(games, draws, profile) {
  const buckets = new Map();
  for (const game of games) {
    const set = new Set(game.numbers);
    for (const draw of draws) {
      let hits = 0;
      for (const number of draw.numbers) if (set.has(number)) hits += 1;
      buckets.set(hits, (buckets.get(hits) ?? 0) + 1);
    }
  }
  const entries = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  return entries.map(([hits, count]) => ({ hits, count, relative: count / (games.length * draws.length || 1) }));
}
