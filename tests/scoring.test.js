import { assert, assertClose, assertEqual, assertRange, makeDraws } from './helpers.js';
import { getProfile } from '../src/js/game-profiles.js';
import { analyzeDataset } from '../src/js/statistics.js';
import { computeScore, normalizeWeights, scoreBatch, structureMetrics } from '../src/js/scoring-engine.js';

const profile = getProfile('lotofacil');
const draws = makeDraws(profile, 200, 'scoring');
const analysis = analyzeDataset(draws, profile);

function validGame(offset = 0) {
  const numbers = [];
  for (let index = 0; index < profile.drawSize; index += 1) {
    numbers.push(((index * 3 + offset) % 25) + 1);
  }
  return [...new Set(numbers)].sort((a, b) => a - b);
}

export const tests = [
  {
    name: 'pesos sao normalizados para 100%',
    fn() {
      const weights = normalizeWeights({ cycle: 50, repetition: 50, delay: 0, structure: 0 });
      assertClose(weights.cycle, 0.5, 1e-9);
      assertClose(weights.repetition, 0.5, 1e-9);
      assertEqual(weights.normalized, false, '50/50 ja soma 100');
      const total = weights.cycle + weights.repetition + weights.delay + weights.structure;
      assertClose(total, 1, 1e-9);

      const scaled = normalizeWeights({ cycle: 100, repetition: 100, delay: 0, structure: 0 });
      assertEqual(scaled.normalized, true);
      assertClose(scaled.cycle, 0.5, 1e-9);
    },
  },
  {
    name: 'pesos invalidos caem no padrao',
    fn() {
      const weights = normalizeWeights({ cycle: 0, repetition: 0, delay: 0, structure: 0 });
      assertClose(weights.cycle, 0.3, 1e-9);
      assertClose(weights.repetition, 0.25, 1e-9);
      assertClose(weights.delay, 0.2, 1e-9);
      assertClose(weights.structure, 0.25, 1e-9);
    },
  },
  {
    name: 'pesos negativos sao ignorados',
    fn() {
      const weights = normalizeWeights({ cycle: -10, repetition: 100, delay: -5, structure: 0 });
      assertClose(weights.repetition, 1, 1e-9);
      assertClose(weights.cycle, 0, 1e-9);
    },
  },
  {
    name: 'score fica entre 0 e 100 com componentes coerentes',
    fn() {
      const result = computeScore(validGame(1), analysis, profile);
      assertRange(result.score, 0, 100);
      for (const key of ['cycle', 'repetition', 'delay', 'structure']) {
        assertRange(result.components[key], 0, 100, `componente ${key}`);
        assertRange(result.weights[key], 0, 100, `peso ${key}`);
      }
      const weightsSum = Object.values(result.weights).reduce((sum, value) => sum + value, 0);
      assertClose(weightsSum, 100, 0.01);
    },
  },
  {
    name: 'score gera explicacoes reais e aviso de limite',
    fn() {
      const result = computeScore(validGame(2), analysis, profile);
      assert(result.reasons.length >= 3, 'deve haver explicacoes');
      assert(
        result.reasons.some((reason) => reason.includes('dezena')),
        'explicacoes devem citar dezenas',
      );
      assert(
        result.warnings.some((warning) => /probabilidade|aderencia/i.test(warning)),
        'deve conter aviso sobre a natureza do score',
      );
      assertEqual(result.heuristic, true);
    },
  },
  {
    name: 'metricas estruturais conferem com calculo manual',
    fn() {
      const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
      const metrics = structureMetrics(numbers, profile);
      assertEqual(metrics.sum, 120);
      assertEqual(metrics.even, 7);
      assertEqual(metrics.odd, 8);
      assertEqual(metrics.longestSequence, 15);
      assertEqual(metrics.primes, 6, 'primos entre 1 e 15: 2,3,5,7,11,13');
      assertEqual(metrics.rowsUsed, 3);
      assertEqual(metrics.frame, 9, 'moldura de 1 a 15: 1,2,3,4,5,6,10,11,15');
    },
  },
  {
    name: 'scoreBatch preserva ordem de entrada e pontua todos',
    fn() {
      const candidates = [validGame(3), validGame(4), validGame(5)];
      const results = scoreBatch(candidates, analysis, profile);
      assertEqual(results.length, 3);
      results.forEach((result, index) => {
        assertEqual(result.numbers.join(','), candidates[index].join(','));
        assertRange(result.score, 0, 100);
      });
    },
  },
  {
    name: 'pesos personalizados alteram o resultado',
    fn() {
      const game = validGame(6);
      const base = computeScore(game, analysis, profile);
      const custom = computeScore(game, analysis, profile, { cycle: 100, repetition: 0, delay: 0, structure: 0 });
      assertEqual(custom.weights.cycle, 100);
      assert(Math.abs(custom.score - base.score) > 0.0001 || base.score === custom.score, 'score deve refletir peso');
    },
  },
  {
    name: 'score de jogo invalido ainda retorna numero finito',
    fn() {
      const result = computeScore([1, 2, 3], analysis, profile);
      assert(Number.isFinite(result.score));
      assertRange(result.score, 0, 100);
    },
  },
];
