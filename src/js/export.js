/**
 * Exportacao e importacao de jogos e analises.
 * Funciona 100% offline (Blob + URL.createObjectURL).
 */

import { sanitizeText } from './formatter.js';

export function timestampSlug(dateValue = new Date()) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function sanitizeFilename(name) {
  return String(name ?? 'arquivo')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

export function buildFilename(prefix, extension, dateValue = new Date()) {
  return sanitizeFilename(`${prefix}-${timestampSlug(dateValue)}.${extension}`);
}

/* ------------------------------------------------------------------ */
/* Serializacao                                                        */
/* ------------------------------------------------------------------ */

export function buildGamesJSON(games, meta = {}) {
  return JSON.stringify(
    {
      application: 'LOTTERY ANALYTICS ENGINE',
      algorithmVersion: meta.algorithmVersion ?? null,
      game: meta.gameId ?? null,
      exportedAt: new Date().toISOString(),
      disclaimer: meta.disclaimer ?? null,
      totalGames: games.length,
      games: games.map((game) => ({
        numbers: game.numbers,
        score: game.score ?? null,
        source: game.source ?? 'app',
        tags: game.tags ?? [],
        notes: game.notes ?? '',
        createdAt: game.createdAt ?? null,
      })),
    },
    null,
    2,
  );
}

export function buildGamesCSV(games) {
  const header = 'dezenas;quantidade;score;origem;tags;notas;criado_em';
  const rows = games.map((game) =>
    [
      game.numbers.join(' '),
      game.numbers.length,
      game.score ?? '',
      game.source ?? '',
      (game.tags ?? []).join('|'),
      String(game.notes ?? '').replace(/[\r\n;]+/g, ' '),
      game.createdAt ?? '',
    ].join(';'),
  );
  return [header, ...rows].join('\n');
}

export function buildGamesTXT(games) {
  return games
    .map((game, index) => `${String(index + 1).padStart(3, '0')}: ${game.numbers.map((n) => String(n).padStart(2, '0')).join(' ')}`)
    .join('\n');
}

export function buildAnalysisJSON(analysis, meta = {}) {
  return JSON.stringify(
    {
      application: 'LOTTERY ANALYTICS ENGINE',
      exportedAt: new Date().toISOString(),
      metadata: {
        algorithmVersion: meta.algorithmVersion ?? null,
        datasetVersion: meta.datasetVersion ?? null,
        datasetHash: meta.datasetHash ?? null,
        datasetLastContest: meta.lastContest ?? null,
        seed: meta.seed ?? null,
        game: analysis.game ?? meta.gameId ?? null,
      },
      analysis,
    },
    null,
    2,
  );
}

export function buildAnalysisCSV(analysis) {
  const rows = [['metrica', 'valor']];
  const push = (metric, value) => rows.push([metric, value]);
  push('jogo', analysis.game);
  push('concursos', analysis.totalDraws);
  push('primeiro_concurso', analysis.firstContest);
  push('ultimo_concurso', analysis.lastContest);
  push('ultima_data', analysis.lastDate);
  push('soma_media', analysis.sums?.stats?.mean);
  push('soma_faixa_central', `${analysis.sums?.stats?.band?.low}-${analysis.sums?.stats?.band?.high}`);
  push('pares_medio', analysis.parity?.stats?.mean);
  push('repeticao_media', analysis.repetition?.stats?.mean);
  push('primos_medio', analysis.primes?.stats?.mean);
  push('sequencia_maxima_media', analysis.sequences?.stats?.mean);
  push('moldura_media', analysis.frame?.stats?.mean);
  push('miolo_medio', analysis.core?.stats?.mean);
  push('ciclo_medio', analysis.cycle?.meanCycleLength);
  push('ciclo_cobertura', analysis.cycle?.coverage);
  push('chi2_frequencia', analysis.frequencySummary?.chiSquare?.statistic);
  push('chi2_pvalor', analysis.frequencySummary?.chiSquare?.pValue);
  for (const item of analysis.frequency ?? []) {
    push(`frequencia_${item.number}`, item.count);
  }
  return rows.map((row) => row.map((cell) => String(cell ?? '')).join(';')).join('\n');
}

export function buildBacktestCSV(result) {
  const rows = [['indicador', 'valor']];
  rows.push(['jogos', result.totalGames]);
  rows.push(['concursos', result.totalDraws]);
  rows.push(['media_acertos', result.averageHits]);
  rows.push(['hit_rate', result.hitRate]);
  rows.push(['custo_total', result.totalCost ?? 'nao_informado']);
  rows.push(['retorno_bruto', result.grossReturn ?? 'nao_calculado']);
  rows.push(['roi', result.roi ?? 'nao_calculado']);
  rows.push([]);
  rows.push(['faixa', 'ocorrencias', 'valor_total', 'premio_medio']);
  for (const tier of result.tierStats ?? []) {
    rows.push([tier.label, tier.count, tier.amount, tier.averagePrize ?? '']);
  }
  return rows.map((row) => row.map((cell) => String(cell ?? '')).join(';')).join('\n');
}

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */

export function downloadFile(filename, content, mime = 'text/plain;charset=utf-8') {
  if (typeof document === 'undefined') throw new Error('download indisponivel fora do navegador');
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { filename, size: blob.size, mime };
}

/* ------------------------------------------------------------------ */
/* Importacao                                                          */
/* ------------------------------------------------------------------ */

export function detectFormat(filename = '', text = '') {
  const name = String(filename).toLowerCase();
  if (name.endsWith('.json')) return 'json';
  if (name.endsWith('.csv')) return 'csv';
  if (name.endsWith('.txt')) return 'txt';
  const trimmed = String(text).trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (trimmed.includes(';') && /dezenas|numeros|n1/i.test(trimmed.split('\n')[0] ?? '')) return 'csv';
  return 'txt';
}

function extractNumbers(value) {
  if (Array.isArray(value)) {
    return value.map((item) => Number.parseInt(item, 10)).filter((item) => Number.isInteger(item));
  }
  if (typeof value === 'string') {
    return value
      .split(/[\s,;|]+/)
      .map((item) => Number.parseInt(item, 10))
      .filter((item) => Number.isInteger(item));
  }
  return [];
}

/**
 * Converte texto importado em registros de jogo (sem validar contra o perfil).
 * A validacao definitiva fica a cargo de validator.validateImportRecord.
 */
export function parseImportedText(text, _profile, format = null) {
  const type = format ?? detectFormat('', text);
  const games = [];
  const invalid = [];

  if (type === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { games: [], invalid: [{ line: 0, reason: `JSON invalido: ${error.message}` }], format: type };
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.games) ? parsed.games : [parsed];
    list.forEach((item, index) => {
      const numbers = extractNumbers(Array.isArray(item) ? item : item?.numbers ?? item?.dezenas);
      if (numbers.length === 0) {
        invalid.push({ line: index + 1, reason: 'registro sem dezenas' });
        return;
      }
      games.push({
        numbers,
        tags: Array.isArray(item?.tags) ? item.tags.map((tag) => sanitizeText(tag, 24)) : [],
        notes: sanitizeText(item?.notes ?? '', 200),
        source: 'import',
      });
    });
    return { games, invalid, format: type };
  }

  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return;
    if (index === 0 && /dezenas|numeros|n1/i.test(trimmed) && !/\d/.test(trimmed.replace(/dezenas|numeros|n1/gi, ''))) return;
    const numbers = extractNumbers(trimmed.replace(/^[^:]*:\s*/, ''));
    if (numbers.length === 0) {
      invalid.push({ line: index + 1, reason: 'linha sem numeros' });
      return;
    }
    games.push({ numbers, tags: [], notes: '', source: 'import' });
  });
  return { games, invalid, format: type === 'csv' ? 'csv' : 'txt' };
}
