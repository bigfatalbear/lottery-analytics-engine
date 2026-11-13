/**
 * Backtesting historico e motor de premiacao.
 * Valores financeiros so sao calculados quando existem dados reais de premio.
 */

import { encodeCombination, intersectionCount } from './bitmask.js';
import { roundTo, mean, median } from './statistics.js';

/** Numero de acertos de um jogo em um concurso. */
export function countHits(numbers, drawNumbers) {
  const set = new Set(drawNumbers);
  let hits = 0;
  for (const number of numbers) if (set.has(number)) hits += 1;
  return hits;
}

/**
 * Valor de premio real para uma faixa de acertos em um concurso.
 * @returns {{known:boolean, value:number|null}}
 */
export function prizeFor(hits, draw, profile) {
  const tier = profile.prizeRules.tiers.find((item) => item.hits === hits);
  if (!tier) return { known: true, value: 0 };
  const prizes = draw?.prizes;
  if (!prizes || !Object.prototype.hasOwnProperty.call(prizes, String(hits))) {
    return { known: false, value: null };
  }
  const value = prizes[String(hits)];
  if (value === null || value === undefined) return { known: false, value: null };
  return { known: true, value: Number(value) };
}

export function normalizeWindow(draws, window) {
  if (!Number.isInteger(window) || window <= 0) return draws;
  return draws.slice(-window);
}

/**
 * Executa backtest de um conjunto de jogos contra um historico.
 *
 * @param {object} options
 * @param {Array<{numbers:number[]}>} options.games
 * @param {Array<{contest:number,date:string,numbers:number[],prizes?:object}>} options.draws
 * @param {object} options.profile
 * @param {number|null} [options.cost] custo por jogo (null/0 => ROI nao calculado)
 * @param {number} [options.window] ultimos N concursos
 */
export function runBacktest(options) {
  const { games, draws, profile, cost = null, window: windowSize = null } = options;
  const selectedDraws = normalizeWindow(draws, windowSize);

  if (!Array.isArray(games) || games.length === 0) {
    return emptyBacktest('nenhum jogo informado');
  }
  if (selectedDraws.length === 0) {
    return emptyBacktest('nenhum concurso no periodo');
  }

  const drawMasks = selectedDraws.map((draw) => encodeCombination(draw.numbers, profile));
  const buckets = new Map();
  const tierCounts = new Map(profile.prizeRules.tiers.map((tier) => [tier.hits, 0]));
  const tierAmounts = new Map(profile.prizeRules.tiers.map((tier) => [tier.hits, 0]));
  const tierKnown = new Map(profile.prizeRules.tiers.map((tier) => [tier.hits, 0]));

  let grossReturn = 0;
  let unknownPrizeEvents = 0;
  let prizeEvents = 0;
  let totalHits = 0;
  let best = { hits: -1, game: null, contest: null };
  let worst = { hits: Number.POSITIVE_INFINITY, game: null, contest: null };
  const perGameStats = games.map(() => ({ hits: 0, total: 0, best: 0, draws: 0 }));

  games.forEach((game, gameIndex) => {
    const mask = encodeCombination(game.numbers, profile);
    for (let index = 0; index < selectedDraws.length; index += 1) {
      const hits = intersectionCount(mask, drawMasks[index]);
      const draw = selectedDraws[index];
      buckets.set(hits, (buckets.get(hits) ?? 0) + 1);
      totalHits += hits;

      const stats = perGameStats[gameIndex];
      stats.hits += hits;
      stats.total += 1;
      stats.draws += 1;
      if (hits > stats.best) stats.best = hits;
      if (hits > best.hits) best = { hits, game: game.numbers, contest: draw.contest };
      if (hits < worst.hits) worst = { hits, game: game.numbers, contest: draw.contest };

      if (tierCounts.has(hits)) {
        tierCounts.set(hits, tierCounts.get(hits) + 1);
        const prize = prizeFor(hits, draw, profile);
        prizeEvents += 1;
        if (prize.known && prize.value !== null) {
          grossReturn += prize.value;
          tierAmounts.set(hits, tierAmounts.get(hits) + prize.value);
          tierKnown.set(hits, tierKnown.get(hits) + 1);
        } else {
          unknownPrizeEvents += 1;
        }
      }
    }
  });

  const totalGames = games.length;
  const totalDraws = selectedDraws.length;
  const totalCost = Number.isFinite(cost) && cost > 0 ? cost * totalGames : null;
  const hasPrizes = prizeEvents > 0 && prizeEvents > unknownPrizeEvents;
  const netReturn = totalCost !== null && hasPrizes ? grossReturn - totalCost : null;
  const roi = totalCost && netReturn !== null ? (netReturn / totalCost) * 100 : null;

  const distribution = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hits, count]) => ({
      hits,
      count,
      relative: count / (totalGames * totalDraws),
    }));

  const tierStats = profile.prizeRules.tiers.map((tier) => ({
    hits: tier.hits,
    label: tier.label,
    count: tierCounts.get(tier.hits) ?? 0,
    knownPrizes: tierKnown.get(tier.hits) ?? 0,
    amount: roundTo(tierAmounts.get(tier.hits) ?? 0, 2),
    averagePrize: tierKnown.get(tier.hits)
      ? roundTo((tierAmounts.get(tier.hits) ?? 0) / tierKnown.get(tier.hits), 2)
      : null,
  }));

  const hitRate = tierStats.reduce((total, tier) => total + tier.count, 0) / (totalGames * totalDraws);

  return {
    totalGames,
    totalDraws,
    contests: { first: selectedDraws[0].contest, last: selectedDraws[selectedDraws.length - 1].contest },
    totalCost,
    grossReturn: hasPrizes ? roundTo(grossReturn, 2) : null,
    netReturn: netReturn === null ? null : roundTo(netReturn, 2),
    roi: roi === null ? null : roundTo(roi, 2),
    averageHits: roundTo(totalHits / (totalGames * totalDraws), 3),
    hitRate: roundTo(hitRate, 4),
    distribution,
    tierStats,
    prizeCoverage: prizeEvents ? roundTo((prizeEvents - unknownPrizeEvents) / prizeEvents, 4) : 0,
    unknownPrizeEvents,
    best,
    worst: Number.isFinite(worst.hits) ? worst : null,
    perGame: perGameStats.map((stats, index) => ({
      numbers: games[index].numbers,
      meanHits: stats.draws ? roundTo(stats.hits / stats.draws, 3) : 0,
      best: stats.best,
    })),
    notes: buildNotes({ hasPrizes, totalCost, prizeEvents, unknownPrizeEvents }),
    generatedAt: new Date().toISOString(),
  };
}

function buildNotes({ hasPrizes, totalCost, prizeEvents, unknownPrizeEvents }) {
  const notes = [];
  if (!hasPrizes) {
    notes.push('Premiacao nao calculada: sem valores financeiros validos no periodo selecionado.');
  }
  if (unknownPrizeEvents > 0) {
    notes.push(`${unknownPrizeEvents} evento(s) de premiacao sem valor conhecido foram desconsiderados no retorno financeiro.`);
  }
  if (totalCost === null) {
    notes.push('Custo por jogo nao informado: ROI nao calculado.');
  }
  if (prizeEvents === 0) {
    notes.push('Nenhuma faixa premiada foi atingida no periodo.');
  }
  notes.push('Desempenho historico nao implica desempenho futuro.');
  return notes;
}

export function emptyBacktest(reason) {
  return {
    totalGames: 0,
    totalDraws: 0,
    totalCost: null,
    grossReturn: null,
    netReturn: null,
    roi: null,
    averageHits: 0,
    hitRate: 0,
    distribution: [],
    tierStats: [],
    prizeCoverage: 0,
    unknownPrizeEvents: 0,
    best: null,
    worst: null,
    perGame: [],
    notes: [reason],
    empty: true,
    generatedAt: new Date().toISOString(),
  };
}

