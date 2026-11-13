#!/usr/bin/env node
/**
 * Pipeline de dados — executado localmente e pelo GitHub Actions.
 *
 * ETAPAS: fetch -> normalizar -> validar -> comparar -> mesclar -> hash -> relatorio -> gravar.
 *
 * Garantias:
 *  - nunca remove concursos existentes;
 *  - nunca grava dataset invalido;
 *  - nunca substitui dataset valido por resposta vazia;
 *  - se todas as fontes falharem, os arquivos permanecem intactos.
 *
 * Uso:
 *   node scripts/update-dataset.mjs
 *   node scripts/update-dataset.mjs --game=lotofacil
 *   node scripts/update-dataset.mjs --dry-run
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getProfile, GAME_IDS } from '../src/js/game-profiles.js';
import { brDateToIso, validateDataset } from '../src/js/validator.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const TIMEOUT_MS = 120000;

const args = new Map(
  process.argv.slice(2).map((raw) => {
    const [key, value = 'true'] = raw.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const only = args.get('game');
const dryRun = args.get('dry-run') === 'true';
const games = only && only !== 'all' ? [only] : GAME_IDS;

/** Providers de dados. Novos providers entram aqui sem alterar o restante do pipeline. */
const PROVIDERS = [
  {
    id: 'loteriascaixa-api',
    label: 'loteriascaixa-api (historico completo)',
    async full(game) {
      return requestJson(`https://loteriascaixa-api.herokuapp.com/api/${game}`);
    },
  },
  {
    id: 'caixa-oficial',
    label: 'Caixa (concurso mais recente)',
    async latest(game) {
      return requestJson(`https://servicebus2.caixa.gov.br/portaldeloterias/api/${game}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LotteryAnalyticsEngine/1.0)' },
      });
    },
  },
];

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: 'application/json', ...(options.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} em ${url}`);
  const text = await response.text();
  if (!text || text.length < 2) throw new Error(`resposta vazia em ${url}`);
  return JSON.parse(text);
}

function toInt(value) {
  const parsed = Number.parseInt(String(value ?? '').replace(/\D/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Converte payload da loteriascaixa-api em concursos normalizados. */
function fromLoteriaCaixa(raw, profile) {
  const list = Array.isArray(raw) ? raw : [raw];
  const draws = [];
  for (const item of list) {
    const contest = toInt(item?.concurso);
    const numbers = (item?.dezenas ?? []).map((value) => toInt(value)).filter((n) => n !== null);
    if (!contest || numbers.length === 0) continue;
    const prizes = {};
    let hasPrize = false;
    for (const prize of item?.premiacoes ?? []) {
      const hits = toInt(String(prize?.descricao ?? '').match(/\d+/)?.[0]);
      if (!hits) continue;
      const winners = toInt(prize?.ganhadores);
      const value = Number(prize?.valorPremio);
      if (winners && Number.isFinite(value) && value > 0) {
        prizes[hits] = Math.round(value * 100) / 100;
        hasPrize = true;
      }
    }
    draws.push({
      contest,
      date: brDateToIso(item?.data),
      numbers,
      prizes: hasPrize ? prizes : null,
      source: 'loteriascaixa-api',
    });
  }
  return draws;
}

/** Converte payload oficial da Caixa (concurso unico) em concurso normalizado. */
function fromCaixa(raw, profile) {
  const contest = toInt(raw?.numero ?? raw?.concurso);
  const numbers = (raw?.listaDezenas ?? raw?.dezenas ?? []).map(toInt).filter((n) => n !== null);
  if (!contest || numbers.length === 0) return [];
  const prizes = {};
  let hasPrize = false;
  for (const prize of raw?.listaRateioPremio ?? []) {
    const hits = toInt(String(prize?.descricaoFaixa ?? '').match(/\d+/)?.[0]);
    if (!hits) continue;
    const winners = toInt(prize?.numeroDeGanhadores);
    const value = Number(prize?.valorPremio);
    if (winners && Number.isFinite(value) && value > 0) {
      prizes[hits] = Math.round(value * 100) / 100;
      hasPrize = true;
    }
  }
  return [
    {
      contest,
      date: brDateToIso(raw?.dataApuracao),
      numbers,
      prizes: hasPrize ? prizes : null,
      source: 'caixa-oficial',
    },
  ];
}

function canonicalDraw(draw) {
  return [draw.contest, draw.date, draw.numbers, draw.prizes ?? null];
}

function computeHash(draws) {
  const hash = createHash('sha256');
  for (const draw of draws) hash.update(JSON.stringify(canonicalDraw(draw)));
  return hash.digest('hex');
}

async function loadExisting(profile) {
  const file = path.join(ROOT, profile.datasetFile);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const check = validateDataset(parsed, profile);
    if (!check.usable) return { dataset: null, broken: true };
    return { dataset: parsed, check };
  } catch (error) {
    console.warn(`[aviso] arquivo existente ilegivel para ${profile.id}: ${error.message}`);
    return { dataset: null, broken: true };
  }
}

async function writeAtomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

function mergeDraws(existing, incoming) {
  const merged = new Map();
  for (const draw of existing ?? []) merged.set(draw.contest, draw);
  let added = 0;
  let updated = 0;
  let ignored = 0;
  for (const draw of incoming) {
    const current = merged.get(draw.contest);
    if (!current) {
      merged.set(draw.contest, draw);
      added += 1;
      continue;
    }
    const changed = JSON.stringify(canonicalDraw(current)) !== JSON.stringify(canonicalDraw(draw));
    if (changed && draw.source === 'official' && !current.source) {
      merged.set(draw.contest, draw);
      updated += 1;
    } else if (changed) {
      // Dados historicos existentes tem prioridade: nunca sobrescreve com resposta divergente.
      ignored += 1;
    }
  }
  const draws = [...merged.values()].sort((a, b) => a.contest - b.contest);
  return { draws, added, updated, ignored };
}

function buildDataset(profile, draws, previous, statistics) {
  const gaps = statistics.gaps > 0;
  const complete = statistics.firstContest === 1 && !gaps;
  return {
    game: profile.id,
    version: 1,
    datasetStatus: complete ? 'complete' : 'partial',
    source: 'official',
    lastUpdated: new Date().toISOString(),
    lastContest: statistics.lastContest ?? previous?.lastContest ?? 0,
    drawCount: draws.length,
    hash: computeHash(draws),
    draws,
  };
}

async function updateGame(profile) {
  const report = {
    game: profile.id,
    providers: [],
    added: 0,
    updated: 0,
    ignored: 0,
    status: 'unchanged',
    errors: [],
    warnings: [],
  };

  const existing = await loadExisting(profile);
  const previousDraws = existing?.dataset?.draws ?? [];
  let incoming = [];

  for (const provider of PROVIDERS) {
    const started = Date.now();
    try {
      const raw = provider.full ? await provider.full(profile.id) : await provider.latest(profile.id);
      const draws = provider.full ? fromLoteriaCaixa(raw, profile) : fromCaixa(raw, profile);
      const took = Date.now() - started;
      report.providers.push({ id: provider.id, ok: true, draws: draws.length, ms: took });
      if (draws.length > 0) {
        incoming = draws;
        break;
      }
      report.warnings.push(`provider ${provider.id} retornou 0 concursos`);
    } catch (error) {
      report.providers.push({ id: provider.id, ok: false, error: error.message, ms: Date.now() - started });
      report.errors.push(`${provider.id}: ${error.message}`);
    }
  }

  if (incoming.length === 0) {
    report.status = previousDraws.length > 0 ? 'kept-existing' : 'no-data';
    report.warnings.push('nenhuma fonte retornou dados; arquivos preservados');
    return report;
  }

  const merged = mergeDraws(previousDraws, incoming);
  report.added = merged.added;
  report.updated = merged.updated;
  report.ignored = merged.ignored;

  if (merged.draws.length === 0) {
    report.status = 'no-data';
    return report;
  }

  const candidate = buildDataset(profile, merged.draws, existing?.dataset ?? null, {
    firstContest: merged.draws[0].contest,
    lastContest: merged.draws[merged.draws.length - 1].contest,
    gaps: merged.draws.some((draw, index) => index > 0 && draw.contest - merged.draws[index - 1].contest > 1)
      ? 1
      : 0,
  });

  const check = validateDataset(candidate, profile);
  report.statistics = check.statistics;
  report.hash = candidate.hash;
  if (!check.valid) {
    report.status = 'invalid-response';
    report.errors.push(...check.errors);
    report.warnings.push(...check.warnings);
    return report;
  }
  if (check.warnings.length > 0) report.warnings.push(...check.warnings);

  const previousHash = existing?.dataset?.hash ?? '';
  if (previousHash === candidate.hash) {
    report.status = 'unchanged';
    return report;
  }

  report.status = merged.added > 0 ? 'updated' : 'rehashed';
  report.lastContest = candidate.lastContest;
  report.drawCount = candidate.draws.length;

  if (!dryRun) {
    const file = path.join(ROOT, profile.datasetFile);
    await writeAtomic(file, `${JSON.stringify(candidate)}\n`);
  }
  return report;
}

async function main() {
  const reports = [];
  for (const game of games) {
    let profile;
    try {
      profile = getProfile(game);
    } catch (error) {
      console.error(`[erro] ${error.message}`);
      process.exitCode = 2;
      continue;
    }
    console.log(`\n== ${profile.name} (${profile.id}) ==`);
    const report = await updateGame(profile);
    reports.push(report);
    const line = `status=${report.status} added=${report.added} ignored=${report.ignored} draws=${report.drawCount ?? '-'} last=${report.lastContest ?? '-'}`;
    console.log(line);
    for (const provider of report.providers) {
      console.log(
        `  provider ${provider.id}: ${provider.ok ? `ok (${provider.draws} concursos, ${provider.ms}ms)` : `falhou (${provider.error})`}`,
      );
    }
    for (const warning of report.warnings) console.log(`  aviso: ${warning}`);
    for (const error of report.errors) console.log(`  erro: ${error}`);
  }

  const summaryFile = path.join(DATA_DIR, 'report.json');
  await writeAtomic(summaryFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), reports })}\n`);
  console.log(`\nRelatorio: ${path.relative(ROOT, summaryFile)}`);

  const fatal = reports.some((report) => report.status === 'invalid-response');
  if (fatal) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[falha fatal] ${error?.stack ?? error}`);
  process.exitCode = 1;
});
