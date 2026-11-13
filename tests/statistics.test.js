import {
  analyzeDataset,
  chiSquarePValue,
  cycleAnalysis,
  delay,
  frequency,
  longestSequence,
  mean,
  median,
  paritySeries,
  percentile,
  repetitionSeries,
  stdDev,
  summarizeSeries,
  sumSeries,
} from '../src/js/statistics.js';
import { assert, assertClose, assertEqual, assertRange, makeDraws } from './helpers.js';
import { getProfile } from '../src/js/game-profiles.js';

const lotofacil = getProfile('lotofacil');
const megasena = getProfile('megasena');

const drawsMegasena = [
  { contest: 1, date: '2020-01-01', numbers: [1, 2, 3, 4, 5, 6] },
  { contest: 2, date: '2020-01-03', numbers: [1, 2, 3, 7, 8, 9] },
  { contest: 3, date: '2020-01-05', numbers: [10, 11, 12, 13, 14, 15] },
];

const drawsCiclo = [
  { contest: 1, date: '2020-01-01', numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
  { contest: 2, date: '2020-01-02', numbers: [1, 2, 3, 4, 5, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25] },
];

export const tests = [
  {
    name: 'media, mediana e desvio padrao',
    fn() {
      const values = [2, 4, 4, 4, 5, 5, 7, 9];
      assertClose(mean(values), 5);
      assertClose(median(values), 4.5);
      assertClose(stdDev([2, 4, 4, 4, 5, 5, 7, 9], false), 2);
      assertEqual(mean([]), 0);
    },
  },
  {
    name: 'percentil interpola linearmente',
    fn() {
      const values = [1, 2, 3, 4, 5];
      assertClose(percentile(values, 0), 1);
      assertClose(percentile(values, 1), 5);
      assertClose(percentile(values, 0.5), 3);
      assertClose(percentile(values, 0.25), 2);
    },
  },
  {
    name: 'frequencia conta aparicoes por dezena',
    fn() {
      const freq = frequency(drawsMegasena, megasena);
      const byNumber = new Map(freq.map((item) => [item.number, item.count]));
      assertEqual(byNumber.get(1), 2);
      assertEqual(byNumber.get(10), 1);
      assertEqual(byNumber.get(60), 0);
      assertEqual(freq.length, 60);
      const total = freq.reduce((sum, item) => sum + item.count, 0);
      assertEqual(total, drawsMegasena.length * megasena.drawSize);
    },
  },
  {
    name: 'atraso identifica dezenas ausentes e zera as presentes',
    fn() {
      const info = delay(drawsMegasena, megasena);
      const byNumber = new Map(info.perNumber.map((item) => [item.number, item]));
      assertEqual(byNumber.get(1).current, 1, 'dezena 1 saiu no concurso 2 de 3');
      assertEqual(byNumber.get(10).current, 0, 'dezena 10 saiu no ultimo concurso');
      assertEqual(byNumber.get(60).current, 3, 'dezena 60 nunca saiu');
      assert(byNumber.get(60).neverDrawn);
    },
  },
  {
    name: 'repeticao compara com o concurso anterior',
    fn() {
      const series = repetitionSeries(drawsMegasena);
      assertEqual(series.length, 2);
      assertEqual(series[0].repeated, 3);
      assertEqual(series[1].repeated, 0);
    },
  },
  {
    name: 'soma e paridade por concurso',
    fn() {
      assertEqual(sumSeries(drawsMegasena)[0], 21);
      const parity = paritySeries(drawsMegasena, megasena);
      assertEqual(parity[0].even, 3);
      assertEqual(parity[0].odd, 3);
    },
  },
  {
    name: 'maior sequencia consecutiva',
    fn() {
      assertEqual(longestSequence([1, 2, 3, 8, 9]), 3);
      assertEqual(longestSequence([1, 3, 5]), 1);
      assertEqual(longestSequence([]), 0);
    },
  },
  {
    name: 'ciclo detecta universo completo',
    fn() {
      const cycle = cycleAnalysis(drawsCiclo, lotofacil);
      assertEqual(cycle.cyclesCompleted, 1);
      assertEqual(cycle.meanCycleLength, 2);
      assertEqual(cycle.drawsInCycle, 0);
      assertEqual(cycle.absent.length, 25);
      assertEqual(cycle.coverage, 0);
    },
  },
  {
    name: 'ciclo parcial conta dezenas ausentes',
    fn() {
      const cycle = cycleAnalysis([drawsCiclo[0]], lotofacil);
      assertEqual(cycle.cyclesCompleted, 0);
      assertEqual(cycle.drawsInCycle, 1);
      assertEqual(cycle.absent.length, 10);
      assertClose(cycle.coverage, 0.6, 0.0001);
    },
  },
  {
    name: 'sumarizacao produz faixa central ordenada',
    fn() {
      const stats = summarizeSeries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert(stats.band.low <= stats.band.high);
      assertEqual(stats.min, 1);
      assertEqual(stats.max, 10);
      assertEqual(stats.count, 10);
      const empty = summarizeSeries([]);
      assertEqual(empty.count, 0);
    },
  },
  {
    name: 'chi-quadrado devolve p-valor plausivel',
    fn() {
      const p = chiSquarePValue(0, 5);
      assertClose(p, 1, 1e-9);
      const low = chiSquarePValue(50, 5);
      assertRange(low, 0, 1);
      assert(low < 0.001, 'estatistica alta deve gerar p baixo');
    },
  },
  {
    name: 'analyzeDataset agrega estrutura completa',
    fn() {
      const draws = makeDraws(lotofacil, 120, 'stats');
      const analysis = analyzeDataset(draws, lotofacil);
      assertEqual(analysis.totalDraws, 120);
      assertEqual(analysis.frequency.length, 25);
      assertEqual(analysis.delay.perNumber.length, 25);
      assert(analysis.sums.stats.mean > 100);
      assert(analysis.cycle.meanCycleLength > 0);
      assertEqual(analysis.cycleNewShare.byBucket.length, 5);
      const totalDistribution = analysis.sums.stats.distribution.reduce((sum, item) => sum + item.count, 0);
      assertEqual(totalDistribution, 120);
    },
  },
  {
    name: 'analyzeDataset com serie vazia devolve estrutura segura',
    fn() {
      const analysis = analyzeDataset([], lotofacil);
      assertEqual(analysis.totalDraws, 0);
      assertEqual(analysis.frequency.length, 0);
      assertEqual(analysis.cycle.absent.length, 0);
      assertEqual(analysis.spatial.cells.length, 0);
    },
  },
];
