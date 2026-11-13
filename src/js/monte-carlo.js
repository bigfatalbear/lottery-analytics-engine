/**
 * Monte Carlo: compara uma estrategia real com jogos puramente aleatorios
 * sobre o mesmo periodo historico.
 *
 * O resultado descreve desempenho dentro do historico observado.
 * Nao e prova de vantagem futura.
 */

import { encodeCombination, intersectionCount } from './bitmask.js';
import { prizeFor } from './backtest-engine.js';
import { sampleDistinct } from './combination-engine.js';
import { mean, median, percentile, roundTo, stdDev } from './statistics.js';

const defaultYield = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * @param {object} options
 * @param {Array<{numbers:number[]}>} options.games estrategia avaliada
 * @param {Array<object>} options.draws historico completo
 * @param {object} options.profile
 * @param {number} [options.simulations=1000]
 * @param {number|null} [options.cost] custo por jogo, para ROI
 * @param {number} [options.window=50] ultimos N concursos
 * @param {number} [options.ticketSize] tamanho dos jogos aleatorios
 * @param {Function} [options.rng]
 * @param {Function} [options.onProgress]
 * @param {Function} [options.isCancelled]
 * @param {Function} [options.yieldFn]
 */
export async function runMonteCarlo(options) {
  const {
    games,
    draws,
    profile,
    simulations = 1000,
    cost = null,
    window: windowSize = 50,
    ticketSize = null,
    rng,
    onProgress = null,
    isCancelled = null,
    yieldFn = defaultYield,
  } = options;

  if (!Array.isArray(games) || games.length === 0) {
    throw new Error('Monte Carlo requer pelo menos um jogo da estrategia');
  }
  if (!Array.isArray(draws) || draws.length === 0) {
    throw new Error('Monte Carlo requer historico de concursos');
  }
  if (!Number.isInteger(simulations) || simulations < 1) {
    throw new Error('numero de simulacoes invalido');
  }

  const selectedDraws = draws.slice(-Math.min(windowSize, draws.length));
  const drawMasks = selectedDraws.map((draw) => encodeCombination(draw.numbers, profile));
  const size = ticketSize ?? games[0].numbers.length;
  const gameCount = games.length;
  const randomSource = rng ?? Math.random;
  const universe = [];
  for (let number = profile.minNumber; number <= profile.maxNumber; number += 1) universe.push(number);

  const strategyMasked = games.map((game) => encodeCombination(game.numbers, profile));
  const strategy = evaluateSet(strategyMasked, drawMasks, selectedDraws, profile, cost, gameCount);

  const results = [];
  const roiResults = [];
  const started = now();

  for (let simulation = 0; simulation < simulations; simulation += 1) {
    if (isCancelled && isCancelled()) {
      return { cancelled: true, simulations: results.length };
    }
    const masks = [];
    for (let index = 0; index < gameCount; index += 1) {
      masks.push(encodeCombination(sampleDistinct(universe, size, randomSource), profile));
    }
    const evaluated = evaluateSet(masks, drawMasks, selectedDraws, profile, cost, gameCount);
    results.push(evaluated.meanHits);
    if (evaluated.roi !== null) roiResults.push(evaluated.roi);

    if (onProgress && simulation % 25 === 0) {
      onProgress({
        processed: simulation,
        total: simulations,
        percent: roundTo((simulation / simulations) * 100, 2),
        elapsed: now() - started,
      });
    }
    if (simulation % 50 === 0) await yieldFn();
  }

  const sorted = [...results].sort((a, b) => a - b);
  const randomStats = {
    mean: roundTo(mean(results), 3),
    median: roundTo(median(results), 3),
    std: roundTo(stdDev(results), 3),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    percentiles: {
      p5: roundTo(percentile(sorted, 0.05), 3),
      p25: roundTo(percentile(sorted, 0.25), 3),
      p50: roundTo(percentile(sorted, 0.5), 3),
      p75: roundTo(percentile(sorted, 0.75), 3),
      p90: roundTo(percentile(sorted, 0.9), 3),
      p95: roundTo(percentile(sorted, 0.95), 3),
      p99: roundTo(percentile(sorted, 0.99), 3),
    },
  };

  const below = results.filter((value) => value <= strategy.meanHits).length;
  const percentileRank = results.length ? roundTo((below / results.length) * 100, 2) : 0;

  return {
    simulations,
    completed: results.length,
    gameCount,
    ticketSize: size,
    draws: { count: selectedDraws.length, first: selectedDraws[0].contest, last: selectedDraws[selectedDraws.length - 1].contest },
    strategy: {
      meanHits: roundTo(strategy.meanHits, 3),
      hitRate: roundTo(strategy.hitRate, 4),
      roi: strategy.roi,
      grossReturn: strategy.grossReturn,
      prizeHits: strategy.prizeHits,
    },
    random: randomStats,
    difference: {
      absolute: roundTo(strategy.meanHits - randomStats.mean, 3),
      relative: randomStats.mean ? roundTo((strategy.meanHits / randomStats.mean - 1) * 100, 2) : 0,
      percentile: percentileRank,
    },
    roiComparison:
      roiResults.length > 0 && strategy.roi !== null
        ? {
            strategy: strategy.roi,
            randomMean: roundTo(mean(roiResults), 2),
            randomMedian: roundTo(median(roiResults), 2),
            percentile: roundTo((roiResults.filter((value) => value <= strategy.roi).length / roiResults.length) * 100, 2),
          }
        : null,
    histogram: buildHistogram(results),
    elapsedMs: now() - started,
    notes: [
      'A comparacao usa o mesmo periodo historico para estrategia e aleatoriedade.',
      `Percentil ${percentileRank}: ${percentileRank}% das simulacoes aleatorias tiveram media de acertos menor ou igual.`,
      'Diferencas dentro da variacao esperada nao indicam vantagem real; nao ha previsao de resultados futuros.',
    ],
  };
}

function evaluateSet(masks, drawMasks, draws, profile, cost, gameCount) {
  let hitsTotal = 0;
  let prizeHits = 0;
  let returns = 0;
  let knownPrize = false;
  for (const mask of masks) {
    for (let index = 0; index < drawMasks.length; index += 1) {
      const hits = intersectionCount(mask, drawMasks[index]);
      hitsTotal += hits;
      if (profile.prizeRules.tiers.some((tier) => tier.hits === hits)) {
        prizeHits += 1;
        const prize = prizeFor(hits, draws[index], profile);
        if (prize.known && prize.value !== null) {
          returns += prize.value;
          knownPrize = true;
        }
      }
    }
  }
  const events = gameCount * drawMasks.length;
  const totalCost = Number.isFinite(cost) && cost > 0 ? cost * gameCount : null;
  return {
    meanHits: events ? hitsTotal / events : 0,
    hitRate: events ? prizeHits / events : 0,
    prizeHits,
    grossReturn: knownPrize ? roundTo(returns, 2) : null,
    roi: totalCost && knownPrize ? roundTo(((returns - totalCost) / totalCost) * 100, 2) : null,
  };
}

function buildHistogram(values, bucketSize = 0.25) {
  if (values.length === 0) return [];
  const buckets = new Map();
  for (const value of values) {
    const bucket = Math.round(value / bucketSize) * bucketSize;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => ({ value: roundTo(value, 2), count, relative: roundTo(count / values.length, 4) }));
}

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}
