import { assert, assertEqual } from './helpers.js';
import { getProfile } from '../src/js/game-profiles.js';
import {
  countHits,
  createMask,
  decodeCombination,
  encodeCombination,
  equals,
  fullMask,
  intersectionCount,
  isSubset,
  jaccard,
  maskKey,
  popcount,
  popcount32,
  wordsFor,
} from '../src/js/bitmask.js';

const lotofacil = getProfile('lotofacil');
const megasena = getProfile('megasena');

export const tests = [
  {
    name: 'popcount32 conta bits corretamente',
    fn() {
      assertEqual(popcount32(0), 0);
      assertEqual(popcount32(1), 1);
      assertEqual(popcount32(0b1011), 3);
      assertEqual(popcount32(0xffffffff), 32);
    },
  },
  {
    name: 'lotofacil usa uma palavra, mega-sena usa duas',
    fn() {
      assertEqual(wordsFor(lotofacil), 1);
      assertEqual(wordsFor(megasena), 2);
      assertEqual(createMask(megasena).length, 2);
    },
  },
  {
    name: 'encode/decode preservam as dezenas',
    fn() {
      const numbers = [1, 5, 9, 13, 17, 21, 25];
      const mask = encodeCombination(numbers, lotofacil);
      assertEqual(popcount(mask), numbers.length);
      assertEqual(decodeCombination(mask, lotofacil).join(','), numbers.join(','));
    },
  },
  {
    name: 'encode/decode funcionam acima do bit 31 (mega-sena)',
    fn() {
      const numbers = [1, 32, 33, 60];
      const mask = encodeCombination(numbers, megasena);
      assertEqual(popcount(mask), 4);
      assertEqual(mask[0] & 1, 1, 'dezena 1 no primeiro word');
      assertEqual(mask[1] >>> 0 > 0, true, 'dezenas > 32 no segundo word');
      assertEqual(decodeCombination(mask, megasena).join(','), numbers.join(','));
    },
  },
  {
    name: 'intersecao e contagem de acertos',
    fn() {
      const a = encodeCombination([1, 2, 3, 4, 5], lotofacil);
      const b = encodeCombination([4, 5, 6, 7, 8], lotofacil);
      assertEqual(intersectionCount(a, b), 2);
      assertEqual(countHits(a, b), 2);
      assertEqual(intersectionCount(a, a), 5);
    },
  },
  {
    name: 'subconjunto e igualdade',
    fn() {
      const a = encodeCombination([1, 2], lotofacil);
      const b = encodeCombination([1, 2, 3], lotofacil);
      assert(isSubset(a, b));
      assert(!isSubset(b, a));
      assert(equals(a, encodeCombination([1, 2], lotofacil)));
      assert(!equals(a, b));
    },
  },
  {
    name: 'jaccard varia de 0 a 1',
    fn() {
      const a = encodeCombination([1, 2, 3], lotofacil);
      const b = encodeCombination([1, 2, 3], lotofacil);
      const c = encodeCombination([4, 5, 6], lotofacil);
      assertEqual(jaccard(a, b), 1);
      assertEqual(jaccard(a, c), 0);
      const partial = jaccard(a, encodeCombination([1, 2, 7], lotofacil));
      assert(partial > 0 && partial < 1);
    },
  },
  {
    name: 'mascara completa cobre todo o universo',
    fn() {
      assertEqual(popcount(fullMask(lotofacil)), 25);
      assertEqual(popcount(fullMask(megasena)), 60);
    },
  },
  {
    name: 'maskKey e estavel e distinta',
    fn() {
      const a = maskKey(encodeCombination([1, 2, 3], megasena));
      const b = maskKey(encodeCombination([1, 2, 3], megasena));
      const c = maskKey(encodeCombination([1, 2, 4], megasena));
      assertEqual(a, b);
      assert(a !== c);
    },
  },
  {
    name: 'encode ignora valores fora do universo',
    fn() {
      const mask = encodeCombination([0, 1, 26, 99], lotofacil);
      assertEqual(popcount(mask), 1);
      assertEqual(decodeCombination(mask, lotofacil)[0], 1);
    },
  },
];
