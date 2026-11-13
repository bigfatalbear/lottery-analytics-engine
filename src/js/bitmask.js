/**
 * Bitmask de dezenas em Uint32Array.
 * Lotofacil (25) usa 1 palavra; Mega-Sena (60) usa 2 palavras.
 * Nenhuma conversao para string binaria em loop critico.
 */

export function wordsFor(profile) {
  return Math.ceil(profile.maxNumber / 32);
}

export function createMask(profile) {
  return new Uint32Array(wordsFor(profile));
}

/** Codifica dezenas em bitmask. Ignora valores fora do universo do perfil. */
export function encodeCombination(numbers, profile, target = null) {
  const mask = target ?? new Uint32Array(wordsFor(profile));
  mask.fill(0);
  const min = profile.minNumber;
  const max = profile.maxNumber;
  for (let index = 0; index < numbers.length; index += 1) {
    const number = numbers[index];
    if (!Number.isInteger(number) || number < min || number > max) continue;
    const bit = number - min;
    mask[bit >>> 5] |= 1 << (bit & 31);
  }
  return mask;
}

export function decodeCombination(mask, profile) {
  const numbers = [];
  const min = profile.minNumber;
  for (let word = 0; word < mask.length; word += 1) {
    let bits = mask[word] >>> 0;
    while (bits !== 0) {
      const low = bits & -bits;
      const position = 31 - Math.clz32(low);
      const number = min + (word << 5) + position;
      if (number <= profile.maxNumber) numbers.push(number);
      bits = (bits ^ low) >>> 0;
    }
  }
  return numbers;
}

/** Popcount de 32 bits (SWAR). */
export function popcount32(value) {
  let v = value >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

export function popcount(mask) {
  let total = 0;
  for (let index = 0; index < mask.length; index += 1) total += popcount32(mask[index]);
  return total;
}

/** Quantidade de dezenas em comum entre duas máscaras. */
export function intersectionCount(a, b) {
  let total = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) total += popcount32(a[index] & b[index]);
  return total;
}

export const countHits = intersectionCount;

export function intersects(a, b) {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if ((a[index] & b[index]) !== 0) return true;
  }
  return false;
}

export function unionMask(a, b) {
  const out = new Uint32Array(Math.max(a.length, b.length));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = (a[index] ?? 0) | (b[index] ?? 0);
  }
  return out;
}

export function andMask(a, b) {
  const out = new Uint32Array(Math.max(a.length, b.length));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = (a[index] ?? 0) & (b[index] ?? 0);
  }
  return out;
}

export function isSubset(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    if ((a[index] & ~(b[index] ?? 0)) !== 0) return false;
  }
  return true;
}

export function equals(a, b) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return false;
  }
  return true;
}

/** Chave textual estavel para deduplicacao (base36 por palavra). */
export function maskKey(mask) {
  let key = '';
  for (let index = 0; index < mask.length; index += 1) {
    key += mask[index].toString(36) + '.';
  }
  return key;
}

/** Similaridade de Jaccard entre duas combinacoes (0..1). */
export function jaccard(a, b) {
  const inter = intersectionCount(a, b);
  const union = popcount(a) + popcount(b) - inter;
  return union === 0 ? 0 : inter / union;
}

/** Cria mascara preenchida com todas as dezenas do universo. */
export function fullMask(profile) {
  const mask = new Uint32Array(wordsFor(profile));
  for (let number = profile.minNumber; number <= profile.maxNumber; number += 1) {
    const bit = number - profile.minNumber;
    mask[bit >>> 5] |= 1 << (bit & 31);
  }
  return mask;
}
