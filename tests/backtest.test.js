import { assert, assertClose, assertEqual, assertRange, makeDraws } from './helpers.js';
import { getProfile } from '../src/js/game-profiles.js';
import { countHits, normalizeWindow, prizeFor, runBacktest } from '../src/js/backtest-engine.js';
import { runMonteCarlo } from '../src/js/monte-carlo.js';
import { createSeededRng } from '../src/js/combination-engine.js';

const profile = getProfile('lotofacil');
const draws = makeDraws(profile, 20, 'backtest');

const game = draws[0].numbers.slice();
const games = [{ numbers: game }, { numbers: draws[1].numbers.slice() }];

export const tests = [
  {
    name: 'countHits conta acertos',
    fn() {
      assertEqual(countHits([1, 2, 3], [1, 2, 4]), 2);
      assertEqual(countHits([1, 2, 3], [4, 5, 6]), 0);
      assertEqual(countHits([], [1]), 0);
    },
  },
  {
    name: 'prizeFor distingue premio conhecido, desconhecido e fora de faixa',
    fn() {
      const drawComPremio = { contest: 1, numbers: [], prizes: { 15: 1000, 14: 200 } };
      assertEqual(prizeFor(15, drawComPremio, profile).value, 1000);
      assertEqual(prizeFor(15, drawComPremio, profile).known, true);
      assertEqual(prizeFor(13, drawComPremio, profile).known, false);
      assertEqual(prizeFor(3, drawComPremio, profile).value, 0, 'fora de faixa nao paga');
    },
  },
  {
    name: 'backtest sem custo nao calcula ROI',
    fn() {
      const result = runBacktest({ games, draws, profile });
      assertEqual(result.totalGames, 2);
      assertEqual(result.totalDraws, 20);
      assertEqual(result.totalCost, null);
      assertEqual(result.roi, null);
      const total = result.distribution.reduce((sum, item) => sum + item.count, 0);
      assertEqual(total, 40);
      assertRange(result.averageHits, 0, 15);
    },
  },
  {
    name: 'backtest com custo e premio calcula ROI real',
    fn() {
      const drawWithPrize = {
        contest: 1,
        date: '2020-01-01',
        numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        prizes: { 15: 1000 },
      };
      const result = runBacktest({
        games: [{ numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] }],
        draws: [drawWithPrize],
        profile,
        cost: 3,
      });
      assertEqual(result.grossReturn, 1000);
      assertEqual(result.totalCost, 3);
      assertEqual(result.netReturn, 997);
      assertClose(result.roi, (997 / 3) * 100, 0.01);
      assertEqual(result.winnerCount ?? result.tierStats[0].count, 1);
    },
  },
  {
    name: 'backtest sem jogos retorna estrutura vazia explicita',
    fn() {
      const result = runBacktest({ games: [], draws, profile });
      assertEqual(result.empty, true);
      assertEqual(result.totalGames, 0);
      assertEqual(result.roi, null);
      assert(result.notes.length > 0);
    },
  },
  {
    name: 'backtest sem concursos retorna estrutura vazia explicita',
    fn() {
      const result = runBacktest({ games, draws: [], profile });
      assertEqual(result.empty, true);
      assertEqual(result.totalDraws, 0);
    },
  },
  {
    name: 'janela limita os concursos avaliados',
    fn() {
      const result = runBacktest({ games, draws, profile, window: 5 });
      assertEqual(result.totalDraws, 5);
      assertEqual(result.contests.last, 20);
      assertEqual(result.contests.first, 16);
      assertEqual(normalizeWindow(draws, 0).length, 20);
      assertEqual(normalizeWindow(draws, 3).length, 3);
    },
  },
  {
    name: 'distribuicao de acertos e consistente',
    fn() {
      const result = runBacktest({ games, draws, profile });
      for (const item of result.distribution) {
        assertRange(item.hits, 0, 15);
        assertRange(item.relative, 0, 1);
      }
      assert(result.best.hits >= result.worst.hits);
    },
  },
  {
    name: 'monte carlo produz comparacao completa',
    async fn() {
      const result = await runMonteCarlo({
        games,
        draws,
        profile,
        simulations: 20,
        window: 10,
        rng: createSeededRng('mc'),
        yieldFn: () => Promise.resolve(),
      });
      assertEqual(result.simulations, 20);
      assertEqual(result.completed, 20);
      assertEqual(result.gameCount, 2);
      assertEqual(result.draws.count, 10);
      assertRange(result.strategy.meanHits, 0, 15);
      assertRange(result.difference.percentile, 0, 100);
      assert(result.random.percentiles.p50 <= result.random.percentiles.p95);
      assert(result.histogram.length > 0);
      assert(result.notes.length >= 2);
      assert(Number.isFinite(result.elapsedMs));
    },
  },
  {
    name: 'monte carlo exige jogos',
    async fn() {
      let raised = false;
      try {
        await runMonteCarlo({ games: [], draws, profile, simulations: 5 });
      } catch {
        raised = true;
      }
      assert(raised);
    },
  },
];
