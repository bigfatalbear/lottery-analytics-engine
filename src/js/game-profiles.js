/**
 * Perfis de modalidade (GAME_PROFILE).
 * Nenhuma regra especifica de loteria deve existir fora deste modulo.
 */

const PRIMES_UP_TO_60 = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59];
const FIBONACCI_UP_TO_60 = [1, 2, 3, 5, 8, 13, 21, 34, 55];

function inRangeSet(list, max) {
  return Object.freeze(list.filter((n) => n <= max));
}

function makeBoard(rows, cols) {
  return Object.freeze({ rows, cols, total: rows * cols });
}

/**
 * Converte um numero de dezena em coordenada de volante (0-based).
 * Layout: preenchimento em linha (row-major).
 */
export function boardCell(profile, number) {
  const index = number - profile.minNumber;
  return {
    row: Math.floor(index / profile.board.cols),
    col: index % profile.board.cols,
    index,
  };
}

/** Numero da dezena a partir de coordenada de volante. */
export function cellNumber(profile, row, col) {
  const value = row * profile.board.cols + col + profile.minNumber;
  return value <= profile.maxNumber && value >= profile.minNumber ? value : null;
}

/** Dezenas na moldura (borda) do volante. */
export function frameNumbers(profile) {
  const result = [];
  for (let n = profile.minNumber; n <= profile.maxNumber; n += 1) {
    const { row, col } = boardCell(profile, n);
    if (row === 0 || col === 0 || row === profile.board.rows - 1 || col === profile.board.cols - 1) {
      result.push(n);
    }
  }
  return result;
}

/** Dezenas no miolo (interior) do volante. */
export function coreNumbers(profile) {
  const result = [];
  for (let n = profile.minNumber; n <= profile.maxNumber; n += 1) {
    const { row, col } = boardCell(profile, n);
    if (row > 0 && col > 0 && row < profile.board.rows - 1 && col < profile.board.cols - 1) {
      result.push(n);
    }
  }
  return result;
}

const LOTOFACIL = {
  id: 'lotofacil',
  name: 'Lotofacil',
  shortName: 'LF',
  minNumber: 1,
  maxNumber: 25,
  drawSize: 15,
  ticketSize: 15,
  minTicketSize: 15,
  maxTicketSize: 20,
  board: makeBoard(5, 5),
  datasetFile: 'data/lotofacil.json',
  prizeRules: {
    valuesFromDataset: true,
    tiers: [
      { hits: 15, label: '15 acertos' },
      { hits: 14, label: '14 acertos' },
      { hits: 13, label: '13 acertos' },
      { hits: 12, label: '12 acertos' },
      { hits: 11, label: '11 acertos' },
    ],
  },
  ticketRules: {
    minNumbers: 15,
    maxNumbers: 20,
    price: null,
    priceNote: 'Valor da aposta nao e distribuido com os dados historicos. Informe o custo manualmente.',
  },
  statisticalFeatures: {
    primes: inRangeSet(PRIMES_UP_TO_60, 25),
    fibonacci: inRangeSet(FIBONACCI_UP_TO_60, 25),
    evenTarget: null,
    sumReference: null,
  },
};

const MEGASENA = {
  id: 'megasena',
  name: 'Mega-Sena',
  shortName: 'MS',
  minNumber: 1,
  maxNumber: 60,
  drawSize: 6,
  ticketSize: 6,
  minTicketSize: 6,
  maxTicketSize: 20,
  board: makeBoard(10, 6),
  datasetFile: 'data/megasena.json',
  prizeRules: {
    valuesFromDataset: true,
    tiers: [
      { hits: 6, label: '6 acertos' },
      { hits: 5, label: '5 acertos' },
      { hits: 4, label: '4 acertos' },
    ],
  },
  ticketRules: {
    minNumbers: 6,
    maxNumbers: 20,
    price: null,
    priceNote: 'Valor da aposta nao e distribuido com os dados historicos. Informe o custo manualmente.',
  },
  statisticalFeatures: {
    primes: inRangeSet(PRIMES_UP_TO_60, 60),
    fibonacci: inRangeSet(FIBONACCI_UP_TO_60, 60),
    evenTarget: null,
    sumReference: null,
  },
};

/** Perfis disponiveis. Congelados: nunca mutar em runtime. */
export const GAME_PROFILES = Object.freeze({
  [LOTOFACIL.id]: Object.freeze(LOTOFACIL),
  [MEGASENA.id]: Object.freeze(MEGASENA),
});

export const GAME_IDS = Object.freeze(Object.keys(GAME_PROFILES));

export function listProfiles() {
  return GAME_IDS.map((id) => GAME_PROFILES[id]);
}

export function findProfile(id) {
  return GAME_PROFILES[id] ?? null;
}

/** Retorna o perfil ou lanca erro explicito (uso interno quando o id ja foi validado). */
export function getProfile(id) {
  const profile = findProfile(id);
  if (!profile) {
    throw new Error(`Perfil de jogo desconhecido: ${String(id)}`);
  }
  return profile;
}

export function isPrime(profile, number) {
  return profile.statisticalFeatures.primes.includes(number);
}

export function isFibonacci(profile, number) {
  return profile.statisticalFeatures.fibonacci.includes(number);
}

export function isFrame(profile, number) {
  return frameNumbers(profile).includes(number);
}

export function hitTier(profile, hits) {
  return profile.prizeRules.tiers.find((tier) => tier.hits === hits) ?? null;
}

export function maxPrizeTier(profile) {
  return profile.prizeRules.tiers.reduce((acc, tier) => (tier.hits > acc.hits ? tier : acc), profile.prizeRules.tiers[0]);
}

/** Lista de numeros validos do universo da modalidade. */
export function universe(profile) {
  const numbers = [];
  for (let n = profile.minNumber; n <= profile.maxNumber; n += 1) numbers.push(n);
  return numbers;
}

/** Resumo do perfil para exibicao. */
export function describeProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    range: `${profile.minNumber} - ${profile.maxNumber}`,
    drawSize: profile.drawSize,
    board: `${profile.board.rows}x${profile.board.cols}`,
    tiers: profile.prizeRules.tiers.map((tier) => tier.label),
  };
}
