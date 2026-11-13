import { assert, assertEqual, assertThrows } from './helpers.js';
import { getProfile } from '../src/js/game-profiles.js';
import {
  brDateToIso,
  detectContestGaps,
  isValidISODate,
  normalizeDraw,
  validateDataset,
  validateDraw,
  validateGame,
  validateImportRecord,
} from '../src/js/validator.js';
import { makeDataset, makeDraws } from './helpers.js';

const profile = getProfile('lotofacil');

export const tests = [
  {
    name: 'brDateToIso converte DD/MM/YYYY',
    fn() {
      assertEqual(brDateToIso('29/09/2003'), '2003-09-29');
      assertEqual(brDateToIso('31/02/2020'), null, 'data inexistente deve falhar');
      assertEqual(brDateToIso('2003-09-29'), null);
    },
  },
  {
    name: 'isValidISODate valida calendario real',
    fn() {
      assert(isValidISODate('2024-02-29'));
      assert(!isValidISODate('2023-02-29'), 'ano nao bissexto');
      assert(!isValidISODate('2024-13-01'));
    },
  },
  {
    name: 'dataset completo e valido',
    fn() {
      const dataset = makeDataset('lotofacil', 30);
      const result = validateDataset(dataset, profile);
      assert(result.valid, `esperava dataset valido: ${result.errors.join('; ')}`);
      assertEqual(result.statistics.validDraws, 30);
      assertEqual(result.statistics.invalidDraws, 0);
      assertEqual(result.statistics.firstContest, 1);
      assertEqual(result.statistics.lastContest, 30);
      assertEqual(result.rejected.length, 0);
    },
  },
  {
    name: 'dataset invalido isola registros ruins sem descartar os bons',
    fn() {
      const dataset = makeDataset('lotofacil', 5);
      dataset.draws[2].numbers = [...dataset.draws[2].numbers.slice(0, 14), dataset.draws[2].numbers[0]];
      const result = validateDataset(dataset, profile);
      assertEqual(result.statistics.validDraws, 4);
      assertEqual(result.statistics.invalidDraws, 1);
      assert(result.usable, 'dataset parcial continua utilizavel');
      assert(result.warnings.length > 0);
    },
  },
  {
    name: 'concurso com dezenas duplicadas e rejeitado',
    fn() {
      const draw = { contest: 1, date: '2020-01-01', numbers: [1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] };
      const result = validateDraw(normalizeDraw(draw, profile), profile);
      assert(!result.valid);
      assert(
        result.errors.some((error) => error.includes('duplicada')),
        'mensagem deve citar duplicidade',
      );
    },
  },
  {
    name: 'concurso com dezena fora do intervalo e rejeitado',
    fn() {
      const draw = { contest: 1, date: '2020-01-01', numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 26] };
      const result = validateDraw(normalizeDraw(draw, profile), profile);
      assert(!result.valid);
      assert(result.errors.some((error) => error.includes('fora do intervalo')));
    },
  },
  {
    name: 'concurso com quantidade errada e rejeitado',
    fn() {
      const draw = { contest: 1, date: '2020-01-01', numbers: [1, 2, 3, 4, 5] };
      const result = validateDraw(normalizeDraw(draw, profile), profile);
      assert(!result.valid);
      assert(result.errors.some((error) => error.includes('quantidade')));
    },
  },
  {
    name: 'concurso duplicado e ignorado e gera aviso',
    fn() {
      const dataset = makeDataset('lotofacil', 4);
      dataset.draws.push({ ...dataset.draws[1] });
      const result = validateDataset(dataset, profile);
      assertEqual(result.statistics.duplicates, 1);
      assertEqual(result.statistics.validDraws, 4);
      assert(result.warnings.some((warning) => warning.includes('duplicado')));
    },
  },
  {
    name: 'detecta lacunas na sequencia de concursos',
    fn() {
      const draws = [
        { contest: 1, date: '2020-01-01', numbers: [] },
        { contest: 5, date: '2020-01-02', numbers: [] },
      ];
      const gaps = detectContestGaps(draws);
      assertEqual(gaps.length, 1);
      assertEqual(gaps[0].missing, 3);
    },
  },
  {
    name: 'validateGame aceita jogo valido',
    fn() {
      const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
      const result = validateGame(numbers, profile);
      assert(result.valid, result.errors.join('; '));
      assertEqual(result.numbers.length, 15);
    },
  },
  {
    name: 'validateGame rejeita tamanho, duplicidade e intervalo',
    fn() {
      assert(!validateGame([1, 2, 3], profile).valid, 'tamanho errado');
      assert(!validateGame([1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], profile).valid, 'duplicada');
      assert(!validateGame([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 30], profile).valid, 'fora do intervalo');
    },
  },
  {
    name: 'validateImportRecord valida e ordena',
    fn() {
      const record = { numbers: [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1] };
      const result = validateImportRecord(record, profile);
      assert(result.valid);
      assertEqual(result.numbers[0], 1);
      assertEqual(result.numbers[14], 15);
    },
  },
  {
    name: 'validateDataset lida com entradas nao objetivas',
    fn() {
      assert(!validateDataset(null, profile).valid);
      assert(!validateDataset({ game: 'lotofacil' }, profile).valid);
      assert(!validateDataset({ game: 'outro', draws: [] }, profile).valid);
    },
  },
  {
    name: 'normalizeDraw ordena sem mascarar duplicatas',
    fn() {
      const draw = normalizeDraw(
        { contest: '7', date: '2020-05-10', numbers: ['5', '3', '5', '1'] },
        profile,
      );
      assertEqual(draw.contest, 7);
      assertEqual(draw.date, '2020-05-10');
      assertEqual(draw.numbers.join(','), '1,3,5,5', 'duplicata preservada para a validacao detectar');
      assert(!validateDraw(draw, profile).valid);
    },
  },
  {
    name: 'validateDataset com draws vazios nao quebra',
    fn() {
      const result = validateDataset({ game: 'lotofacil', draws: [] }, profile);
      assert(!result.valid);
      assert(!result.usable);
      assert(result.warnings.some((warning) => warning.includes('sem concursos')));
    },
  },
];
