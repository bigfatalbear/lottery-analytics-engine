/**
 * Validacao de datasets, concursos e jogos.
 * Funcoes puras, sem DOM, reutilizadas pelo navegador, pelo Worker, pelos testes e pelo pipeline de dados.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Converte "DD/MM/YYYY" em "YYYY-MM-DD". Retorna null quando invalido. */
export function brDateToIso(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  const iso = `${year}-${month}-${day}`;
  return isValidISODate(iso) ? iso : null;
}

/** Verifica data ISO real (nao apenas formato). */
export function isValidISODate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizeNumbers(raw) {
  if (!Array.isArray(raw)) return [];
  const numbers = [];
  for (const item of raw) {
    const value = typeof item === 'string' ? Number.parseInt(item, 10) : item;
    if (!Number.isInteger(value)) return null;
    numbers.push(value);
  }
  return numbers;
}

function normalizePrizes(raw, profile) {
  if (!raw || typeof raw !== 'object') return null;
  const result = {};
  let found = false;
  for (const tier of profile.prizeRules.tiers) {
    const key = String(tier.hits);
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      const value = raw[key];
      if (value === null) {
        result[key] = null;
        found = true;
      } else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        result[key] = value;
        found = true;
      } else {
        return null;
      }
    }
  }
  return found ? result : null;
}

/**
 * Normaliza um concurso bruto para o formato do dataset.
 * Nao valida: apenas converte tipos e ordena dezenas.
 */
export function normalizeDraw(raw, profile) {
  const numbers = normalizeNumbers(raw?.numbers);
  return {
    contest: Number.parseInt(raw?.contest, 10),
    date: typeof raw?.date === 'string' ? raw.date.trim() : '',
    // Ordena sem remover duplicatas: a duplicidade precisa ser detectada pela validacao.
    numbers: numbers ? [...numbers].sort((a, b) => a - b) : [],
    prizes: normalizePrizes(raw?.prizes, profile),
    source: typeof raw?.source === 'string' && raw.source ? raw.source : 'official',
  };
}

/**
 * Valida um unico concurso ja normalizado.
 * @returns {{valid:boolean, errors:string[], warnings:string[]}}
 */
export function validateDraw(draw, profile) {
  const errors = [];
  const warnings = [];

  if (!draw || typeof draw !== 'object') {
    return { valid: false, errors: ['concurso nao e um objeto'], warnings };
  }
  if (!isPositiveInt(draw.contest)) errors.push('concurso invalido (deve ser inteiro positivo)');
  if (!isValidISODate(draw.date)) errors.push(`data invalida: ${JSON.stringify(draw.date)}`);

  const numbers = draw.numbers;
  if (!Array.isArray(numbers) || numbers.length === 0) {
    errors.push('lista de dezenas ausente');
  } else {
    const seen = new Set();
    for (const number of numbers) {
      if (!Number.isInteger(number)) {
        errors.push(`dezena nao inteira: ${JSON.stringify(number)}`);
        continue;
      }
      if (number < profile.minNumber || number > profile.maxNumber) {
        errors.push(`dezena ${number} fora do intervalo ${profile.minNumber}-${profile.maxNumber}`);
      }
      if (seen.has(number)) errors.push(`dezena duplicada: ${number}`);
      seen.add(number);
    }
    if (numbers.length !== profile.drawSize) {
      errors.push(`quantidade de dezenas ${numbers.length} diferente de ${profile.drawSize}`);
    }
    const sorted = numbers.every((value, index) => index === 0 || numbers[index - 1] < value);
    if (!sorted) warnings.push('dezenas fora de ordem crescente (normalizadas no carregamento)');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Valida o dataset completo. Nunca descarta o objeto recebido.
 * @param {object} dataset
 * @param {object} profile
 * @param {{strict?: boolean}} [options]
 */
export function validateDataset(dataset, profile, options = {}) {
  const errors = [];
  const warnings = [];
  const rejected = [];

  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) {
    return {
      valid: false,
      usable: false,
      errors: ['dataset nao e um objeto'],
      warnings,
      statistics: emptyDatasetStatistics(),
      draws: [],
      rejected,
    };
  }

  if (dataset.game !== profile.id) {
    errors.push(`dataset.game "${dataset.game}" diferente do perfil "${profile.id}"`);
  }
  if (!Array.isArray(dataset.draws)) {
    errors.push('dataset.draws nao e um array');
    return {
      valid: false,
      usable: false,
      errors,
      warnings,
      statistics: emptyDatasetStatistics(),
      draws: [],
      rejected,
    };
  }
  if (dataset.draws.length === 0) {
    warnings.push('dataset sem concursos');
  }

  const byContest = new Map();
  let duplicateContests = 0;
  let normalized = 0;

  for (const raw of dataset.draws) {
    if (!raw || typeof raw !== 'object') {
      rejected.push({ contest: null, reasons: ['registro invalido (nao e objeto)'] });
      continue;
    }
    const draw = normalizeDraw(raw, profile);
    const check = validateDraw(draw, profile);
    if (!check.valid) {
      rejected.push({ contest: Number.isFinite(draw.contest) ? draw.contest : null, reasons: check.errors });
      continue;
    }
    if (check.warnings.length > 0 || raw.contest !== draw.contest || raw.date !== draw.date) {
      normalized += 1;
    }
    if (byContest.has(draw.contest)) {
      duplicateContests += 1;
      rejected.push({ contest: draw.contest, reasons: ['concurso duplicado no dataset'] });
      continue;
    }
    byContest.set(draw.contest, draw);
  }

  const draws = [...byContest.values()].sort((a, b) => a.contest - b.contest);
  const gaps = detectContestGaps(draws);

  if (duplicateContests > 0) warnings.push(`${duplicateContests} concurso(s) duplicado(s) ignorado(s)`);
  if (rejected.length > 0) warnings.push(`${rejected.length} registro(s) invalido(s) isolado(s)`);
  if (gaps.length > 0) warnings.push(`${gaps.length} lacuna(s) na sequencia de concursos`);
  if (normalized > 0) warnings.push(`${normalized} registro(s) normalizado(s)`);

  const outOfOrder = dataset.draws.some(
    (raw, index) => index > 0 && Number(raw?.contest) < Number(dataset.draws[index - 1]?.contest),
  );
  if (outOfOrder) warnings.push('concursos fora de ordem cronologica no arquivo original');

  for (const draw of draws) {
    if (draw.date > new Date().toISOString().slice(0, 10)) {
      warnings.push(`concurso ${draw.contest} com data futura: ${draw.date}`);
      break;
    }
  }

  const statistics = {
    totalDraws: dataset.draws.length,
    validDraws: draws.length,
    invalidDraws: rejected.length,
    duplicates: duplicateContests,
    normalized,
    gaps: gaps.length,
    gapList: gaps.slice(0, 50),
    firstContest: draws.length ? draws[0].contest : null,
    lastContest: draws.length ? draws[draws.length - 1].contest : null,
    firstDate: draws.length ? draws[0].date : null,
    lastDate: draws.length ? draws[draws.length - 1].date : null,
  };

  if (options.strict && warnings.length > 0) {
    // Em modo estrito, avisos de dados sao promovidos a erro (usado pelo pipeline).
    errors.push(...warnings);
  }

  const valid = errors.length === 0 && draws.length > 0;
  return { valid, usable: draws.length > 0, errors, warnings, statistics, draws, rejected };
}

export function emptyDatasetStatistics() {
  return {
    totalDraws: 0,
    validDraws: 0,
    invalidDraws: 0,
    duplicates: 0,
    normalized: 0,
    gaps: 0,
    gapList: [],
    firstContest: null,
    lastContest: null,
    firstDate: null,
    lastDate: null,
  };
}

/** Lista de lacunas entre concursos consecutivos (limite de seguranca de 1000 entradas). */
export function detectContestGaps(draws) {
  const gaps = [];
  for (let index = 1; index < draws.length && gaps.length < 1000; index += 1) {
    const previous = draws[index - 1].contest;
    const current = draws[index].contest;
    if (current - previous > 1) {
      gaps.push({ after: previous, before: current, missing: current - previous - 1 });
    }
  }
  return gaps;
}

/**
 * Valida um jogo (combinacao do usuario).
 * @param {number[]} numbers
 * @param {object} profile
 * @param {{ticketSize?: number}} [options]
 */
export function validateGame(numbers, profile, options = {}) {
  const errors = [];
  const warnings = [];
  const expected =
    Number.isInteger(options.ticketSize) && options.ticketSize > 0
      ? options.ticketSize
      : profile.ticketSize;

  if (!Array.isArray(numbers)) {
    return { valid: false, errors: ['jogo nao e uma lista de dezenas'], warnings, numbers: [] };
  }
  if (expected < profile.minTicketSize || expected > profile.maxTicketSize) {
    errors.push(
      `tamanho de jogo ${expected} fora do permitido (${profile.minTicketSize}-${profile.maxTicketSize})`,
    );
  }
  if (numbers.length !== expected) {
    errors.push(`jogo com ${numbers.length} dezenas; esperado ${expected}`);
  }

  const seen = new Set();
  for (const number of numbers) {
    if (!Number.isInteger(number)) {
      errors.push(`dezena invalida: ${JSON.stringify(number)}`);
      continue;
    }
    if (number < profile.minNumber || number > profile.maxNumber) {
      errors.push(`dezena ${number} fora do intervalo ${profile.minNumber}-${profile.maxNumber}`);
    }
    if (seen.has(number)) errors.push(`dezena repetida: ${number}`);
    seen.add(number);
  }

  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  if (numbers.some((value, index) => index > 0 && numbers[index - 1] > value)) {
    warnings.push('dezenas fora de ordem (reordenadas)');
  }

  return { valid: errors.length === 0, errors, warnings, numbers: sorted };
}

/** Valida um registro de importacao vindo de TXT/CSV/JSON. */
export function validateImportRecord(record, profile) {
  const numbers = Array.isArray(record?.numbers) ? record.numbers : [];
  const result = validateGame(numbers, profile, { ticketSize: record?.ticketSize ?? numbers.length });
  return {
    valid: result.valid,
    errors: result.errors,
    numbers: result.numbers,
    meta: {
      source: record?.source ?? 'import',
      tags: Array.isArray(record?.tags) ? record.tags.slice(0, 10) : [],
      notes: typeof record?.notes === 'string' ? record.notes.slice(0, 500) : '',
    },
  };
}
