import { assert, assertEqual, assertThrows } from './helpers.js';
import { getProfile } from '../src/js/game-profiles.js';
import {
  binomial,
  buildWeights,
  createDefaultFilters,
  createSeededRng,
  dedupe,
  evaluateFilters,
  generateClosure,
  generateFiltered,
  generateRandom,
  normalizeFilters,
  parseGamesFromText,
  sampleDistinct,
  selectDiverse,
  strategyToOptions,
  totalCombinations,
} from '../src/js/combination-engine.js';
import { analyzeDataset } from '../src/js/statistics.js';
import { makeDraws } from './helpers.js';

const profile = getProfile('lotofacil');

function baseFilters() {
  return createDefaultFilters(profile);
}

export const tests = [
  {
    name: 'coeficiente binomial confere',
    fn() {
      assertEqual(binomial(25, 15).toString(), '3268760');
      assertEqual(binomial(60, 6).toString(), '50063860');
      assertEqual(binomial(5, 0).toString(), '1');
      assertEqual(binomial(3, 5).toString(), '0');
      assertEqual(totalCombinations(profile, 15).toString(), '3268760');
    },
  },
  {
    name: 'PRNG com seed e deterministico',
    fn() {
      const a = createSeededRng('abc');
      const b = createSeededRng('abc');
      const c = createSeededRng('abd');
      const first = [a(), a(), a()];
      const second = [b(), b(), b()];
      assertEqual(first.join(','), second.join(','));
      assert(first.join(',') !== [c(), c(), c()].join(','), 'seeds diferentes devem divergir');
    },
  },
  {
    name: 'amostragem devolve dezenas distintas e ordenadas',
    fn() {
      const rng = createSeededRng('sample');
      const sample = sampleDistinct([1, 2, 3, 4, 5, 6], 4, rng);
      assertEqual(sample.length, 4);
      assertEqual(new Set(sample).size, 4);
      assertEqual([...sample].sort((x, y) => x - y).join(','), sample.join(','));
    },
  },
  {
    name: 'geracao aleatoria respeita tamanho e intervalo',
    fn() {
      const result = generateRandom({
        profile,
        size: 15,
        count: 10,
        rng: createSeededRng('random'),
        filters: baseFilters(),
      });
      assertEqual(result.games.length, 10);
      for (const game of result.games) {
        assertEqual(game.length, 15);
        assertEqual(new Set(game).size, 15);
        assert(game.every((number) => number >= 1 && number <= 25));
      }
    },
  },
  {
    name: 'filtro de soma e respeitado em todos os jogos',
    fn() {
      const filters = baseFilters();
      filters.sum = { min: 190, max: 200 };
      const result = generateFiltered({
        profile,
        size: 15,
        count: 8,
        filters,
        rng: createSeededRng('sum'),
      });
      assert(result.games.length > 0, 'deveria gerar jogos');
      for (const game of result.games) {
        const sum = game.reduce((total, number) => total + number, 0);
        assert(sum >= 190 && sum <= 200, `soma ${sum} fora do filtro`);
      }
    },
  },
  {
    name: 'filtros de fixas e excluidas sao aplicados',
    fn() {
      const filters = baseFilters();
      filters.fixed = [1, 2, 3];
      filters.excluded = [4, 5, 6];
      const result = generateFiltered({
        profile,
        size: 15,
        count: 5,
        filters,
        rng: createSeededRng('fixed'),
      });
      assert(result.games.length > 0);
      for (const game of result.games) {
        assert(game.includes(1) && game.includes(2) && game.includes(3), 'deve conter as fixas');
        assert(!game.includes(4) && !game.includes(5) && !game.includes(6), 'nao deve conter as excluidas');
      }
    },
  },
  {
    name: 'filtro impossivel nao gera jogos e nao trava',
    fn() {
      const filters = baseFilters();
      filters.sum = { min: 1000, max: 1001 };
      const result = generateFiltered({
        profile,
        size: 15,
        count: 5,
        filters,
        rng: createSeededRng('impossible'),
        maxAttempts: 1000,
      });
      assertEqual(result.games.length, 0);
      assert(result.attempts <= 1000);
    },
  },
  {
    name: 'normalizeFilters descarta valores invalidos',
    fn() {
      const filters = normalizeFilters({ fixed: [1, 1, 99, 'x'], excluded: [2, 2], even: { min: 5, max: 3 } }, profile);
      assertEqual(filters.fixed.join(','), '1');
      assertEqual(filters.excluded.join(','), '2');
      assertEqual(filters.even.min, 3, 'min e max sao ordenados');
      assertEqual(filters.even.max, 5);
    },
  },
  {
    name: 'validacao rejeita filtros incoerentes',
    fn() {
      const filters = baseFilters();
      filters.fixed = Array.from({ length: 20 }, (_, index) => index + 1);
      assertThrows(() => generateFiltered({ profile, size: 15, count: 1, filters, rng: createSeededRng('x') }));
    },
  },
  {
    name: 'evaluateFilters aponta violacoes com rotulo',
    fn() {
      const filters = baseFilters();
      filters.even = { min: 14, max: 15 };
      const numbers = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 2, 4];
      const verdict = evaluateFilters(numbers, filters, { profile });
      assert(!verdict.ok);
      assert(verdict.violations.some((violation) => violation.key === 'even' && violation.label === 'Pares'));
    },
  },
  {
    name: 'dedupe remove repeticoes preservando ordem',
    fn() {
      const unique = dedupe(
        [
          [1, 2, 3],
          [1, 2, 3],
          [4, 5, 6],
        ],
        profile,
      );
      assertEqual(unique.length, 2);
      assertEqual(unique[1].join(','), '4,5,6');
    },
  },
  {
    name: 'selecao diversificada respeita o limite',
    fn() {
      const candidates = [
        { numbers: [1, 2, 3], score: 90 },
        { numbers: [1, 2, 3], score: 80 },
        { numbers: [4, 5, 6], score: 70 },
        { numbers: [7, 8, 9], score: 60 },
      ];
      const selected = selectDiverse(candidates, 3, 0.5);
      assertEqual(selected.length, 3);
      assertEqual(selected[0].numbers.join(','), '1,2,3', 'maior score primeiro');
    },
  },
  {
    name: 'estrategias produzem filtros e pesos coerentes',
    fn() {
      const analysis = analyzeDataset(makeDraws(profile, 60, 'strategy'), profile);
      for (const strategy of ['conservadora', 'balanceada', 'diversificada', 'alta-frequencia', 'aleatoria']) {
        const options = strategyToOptions(strategy, analysis, profile);
        assert(options.filters, `estrategia ${strategy} deve ter filtros`);
        assertEqual(typeof options.diversity, 'number');
      }
      const weights = buildWeights(analysis, profile, 'hot');
      assertEqual(weights.numbers.length, 25);
      assertEqual(weights.weights.length, 25);
      assert(weights.weights.every((weight) => weight > 0));
    },
  },
  {
    name: 'fechamento calcula cobertura de pares',
    fn() {
      const base = Array.from({ length: 18 }, (_, index) => index + 1);
      const result = generateClosure({
        profile,
        base,
        size: 15,
        maxGames: 10,
        rng: createSeededRng('closure'),
      });
      assertEqual(result.games.length, 10);
      assert(result.coverage.pairsTotal > 0);
      assert(result.coverage.pairsCovered > 0);
      assert(result.coverage.ratio > 0 && result.coverage.ratio <= 1);
      assertEqual(result.coverage.baseNumbersTotal, 18);
      assert(result.totalPossible !== '0');
    },
  },
  {
    name: 'fechamento rejeita base menor que o jogo',
    fn() {
      assertThrows(() => generateClosure({ profile, base: [1, 2, 3], size: 15, maxGames: 5 }));
    },
  },
  {
    name: 'parser de texto extrai jogos e sinaliza invalidos',
    fn() {
      const text = '01 02 03 04 05 06 07 08 09 10 11 12 13 14 15\nlinha invalida\n16 17 18 19 20 21 22 23 24 25 1 2 3 4 5';
      const result = parseGamesFromText(text, profile);
      assertEqual(result.games.length, 2);
      assertEqual(result.invalid.length, 1);
    },
  },
];
