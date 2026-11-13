/**
 * Worker de processamento pesado + dispatcher reutilizavel.
 *
 * O mesmo modulo e usado:
 *  - dentro do Web Worker (postMessage);
 *  - como fallback na Main Thread (import dinamico + execute), quando Worker nao existe.
 *
 * Protocolo:
 *   requisicao: {id, type, payload}
 *   resposta:   {id, type, success, data, error, metrics}
 *   progresso:  {id, type:'PROGRESS', progress, processed, total, elapsed}
 */

import { ALGORITHM_VERSION, LIMITS, WORKER_MESSAGES } from '../js/config.js';
import { getProfile } from '../js/game-profiles.js';
import { analyzeDataset } from '../js/statistics.js';
import { computeScore, scoreBatch } from '../js/scoring-engine.js';
import {
  createDefaultFilters,
  createSeededRng,
  createCryptoRng,
  generateClosure,
  generateFiltered,
  rankCandidates,
  strategyToOptions,
} from '../js/combination-engine.js';
import { runBacktest } from '../js/backtest-engine.js';
import { runMonteCarlo } from '../js/monte-carlo.js';
import { validateDataset, validateGame } from '../js/validator.js';

const sessions = new Map();
const cancelled = new Set();

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/** Remove series longas da analise antes de enviar para a Main Thread. */
export function trimAnalysis(analysis) {
  if (!analysis) return null;
  const clone = structuredCloneSafe(analysis);
  const dropSeries = (node) => {
    if (node && typeof node === 'object' && 'series' in node) node.series = [];
    return node;
  };
  dropSeries(clone.sums);
  dropSeries(clone.parity);
  dropSeries(clone.primes);
  dropSeries(clone.fibonacci);
  dropSeries(clone.sequences);
  dropSeries(clone.lines);
  dropSeries(clone.columns);
  dropSeries(clone.frame);
  dropSeries(clone.core);
  if (clone.repetition) clone.repetition.series = [];
  if (clone.cycle) clone.cycle.completed = [];
  if (clone.cycleNewShare) clone.cycleNewShare.series = [];
  for (const key of ['sums', 'parity', 'primes', 'fibonacci', 'sequences']) {
    if (clone[key]?.stats?.distribution) clone[key].stats.distribution = clone[key].stats.distribution.slice(-80);
  }
  return clone;
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* cai para JSON */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function requireSession(gameId) {
  const session = sessions.get(gameId);
  if (!session) {
    throw new Error(`jogo nao inicializado no worker: ${gameId}`);
  }
  return session;
}

function buildSession(gameId, dataset, windowSize = 0) {
  const profile = getProfile(gameId);
  const check = validateDataset(dataset, profile);
  if (!check.usable) {
    throw new Error(`dataset invalido para ${gameId}: ${check.errors.join('; ') || 'sem concursos'}`);
  }
  const analysisDraws =
    Number.isInteger(windowSize) && windowSize > 0 && windowSize < check.draws.length
      ? check.draws.slice(-windowSize)
      : check.draws;
  const analysis = analyzeDataset(analysisDraws, profile);
  const session = {
    gameId,
    profile,
    dataset: { ...dataset, draws: check.draws },
    analysis,
    analysisWindow: analysisDraws.length,
    hash: dataset.hash ?? null,
    lastContest: check.statistics.lastContest,
    totalDraws: check.draws.length,
    initializedAt: new Date().toISOString(),
  };
  sessions.set(gameId, session);
  return session;
}

function resolveRng(seed) {
  if (seed === undefined || seed === null || seed === '') return { rng: createCryptoRng(), seeded: false, seed: null };
  return { rng: createSeededRng(seed), seeded: true, seed: String(seed) };
}

function resolveInputs(session, payload) {
  const strategy = payload.strategy && payload.strategy !== 'personalizada' ? payload.strategy : null;
  const preset = strategy ? strategyToOptions(strategy, session.analysis, session.profile) : null;
  const size = Number.isInteger(payload.size) ? payload.size : session.profile.ticketSize;
  const filters = payload.filters ?? preset?.filters ?? createDefaultFilters(session.profile);
  const weightMode = payload.weightMode !== undefined ? payload.weightMode : preset?.weightMode ?? null;
  const diversity = payload.diversity ?? preset?.diversity ?? undefined;
  return { size, filters, weightMode, diversity, strategy };
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function handleInit(payload) {
  const session = buildSession(payload.gameId, payload.dataset, payload.window ?? 0);
  return {
    gameId: session.gameId,
    totalDraws: session.totalDraws,
    analysisWindow: session.analysisWindow,
    lastContest: session.lastContest,
    hash: session.hash,
    analysis: trimAnalysis(session.analysis),
    profile: {
      id: session.profile.id,
      name: session.profile.name,
      minNumber: session.profile.minNumber,
      maxNumber: session.profile.maxNumber,
      drawSize: session.profile.drawSize,
      ticketSize: session.profile.ticketSize,
    },
  };
}

async function handleAnalyze(payload) {
  const session = requireSession(payload.gameId);
  const windowSize = Number.isInteger(payload.window) && payload.window > 0 ? payload.window : session.dataset.draws.length;
  const draws = session.dataset.draws.slice(-windowSize);
  const analysis = analyzeDataset(draws, session.profile);
  return {
    gameId: session.gameId,
    window: windowSize,
    analysis: trimAnalysis(analysis),
  };
}

async function handleGenerate(payload, ctx) {
  const session = requireSession(payload.gameId);
  const inputs = resolveInputs(session, payload);
  const { rng, seeded, seed } = resolveRng(payload.seed);
  const count = Math.min(payload.count ?? 10, LIMITS.maxCandidates);
  const result = generateFiltered({
    profile: session.profile,
    size: inputs.size,
    count,
    filters: inputs.filters,
    analysis: session.analysis,
    rng,
    previousDraw: session.dataset.draws[session.dataset.draws.length - 1] ?? null,
    weightMode: inputs.weightMode,
    diversity: inputs.diversity,
    onProgress: (progress) => ctx.report(progress),
    isCancelled: () => cancelled.has(ctx.requestId),
  });
  return {
    ...result,
    seed,
    seeded,
    strategy: inputs.strategy,
    size: inputs.size,
    games: result.games.map((numbers) => ({ numbers })),
  };
}

async function handleRank(payload, ctx) {
  const session = requireSession(payload.gameId);
  const inputs = resolveInputs(session, payload);
  const { rng, seeded, seed } = resolveRng(payload.seed);
  const count = Math.min(payload.count ?? 10, 500);
  const candidateCount = Math.min(payload.candidateCount ?? Math.max(count * 40, 200), LIMITS.maxCandidates);
  const result = rankCandidates({
    profile: session.profile,
    analysis: session.analysis,
    weights: payload.weights ?? null,
    count,
    candidateCount,
    size: inputs.size,
    filters: inputs.filters,
    rng,
    previousDraw: session.dataset.draws[session.dataset.draws.length - 1] ?? null,
    weightMode: inputs.weightMode,
    diversity: inputs.diversity,
    seed: payload.seed,
    onProgress: (progress) => ctx.report(progress),
    isCancelled: () => cancelled.has(ctx.requestId),
  });
  return {
    ...result,
    seed,
    seeded,
    strategy: inputs.strategy,
    size: inputs.size,
    weightsUsed: inputs.strategy ? 'default' : 'custom',
  };
}

async function handleBacktest(payload) {
  const session = requireSession(payload.gameId);
  const games = Array.isArray(payload.games) ? payload.games : [];
  games.forEach((game, index) => {
    const check = validateGame(game.numbers, session.profile, { ticketSize: game.numbers.length });
    if (!check.valid) {
      throw new Error(`jogo ${index + 1} invalido: ${check.errors.join('; ')}`);
    }
  });
  return runBacktest({
    games,
    draws: session.dataset.draws,
    profile: session.profile,
    cost: payload.cost ?? null,
    window: payload.window ?? null,
  });
}

async function handleMonteCarlo(payload, ctx) {
  const session = requireSession(payload.gameId);
  const games = Array.isArray(payload.games) ? payload.games : [];
  if (games.length === 0) throw new Error('informe jogos para o Monte Carlo');
  const { rng, seeded, seed } = resolveRng(payload.seed);
  const windowSize = Math.min(payload.window ?? 50, LIMITS.maxMonteCarloDraws);
  const simulations = Math.min(payload.simulations ?? 1000, 100000);
  const result = await runMonteCarlo({
    games,
    draws: session.dataset.draws,
    profile: session.profile,
    simulations,
    cost: payload.cost ?? null,
    window: windowSize,
    ticketSize: payload.ticketSize ?? games[0].numbers.length,
    rng,
    onProgress: (progress) =>
      ctx.report({
        percent: progress.percent,
        processed: progress.processed,
        total: progress.total,
        elapsed: progress.elapsed,
      }),
    isCancelled: () => cancelled.has(ctx.requestId),
  });
  return { ...result, seed, seeded };
}

async function handleClose(payload) {
  const session = requireSession(payload.gameId);
  const { rng, seeded, seed } = resolveRng(payload.seed);
  const result = generateClosure({
    profile: session.profile,
    base: payload.base ?? [],
    size: payload.size ?? session.profile.ticketSize,
    maxGames: Math.min(payload.maxGames ?? 20, 2000),
    rng,
    filters: payload.filters ?? null,
  });
  return { ...result, seed, seeded };
}

async function handleBenchmark(payload, ctx) {
  const session = requireSession(payload.gameId);
  const inputs = resolveInputs(session, payload);
  const { rng } = resolveRng(payload.seed ?? 'benchmark');
  const count = Math.min(payload.count ?? 1000, 50000);
  const started = now();
  const generated = generateFiltered({
    profile: session.profile,
    size: inputs.size,
    count,
    filters: inputs.filters,
    analysis: session.analysis,
    rng,
    previousDraw: session.dataset.draws[session.dataset.draws.length - 1] ?? null,
    weightMode: inputs.weightMode,
    diversity: 0,
    isCancelled: () => cancelled.has(ctx.requestId),
  });
  const generationMs = now() - started;
  const scoringStarted = now();
  const scored = scoreBatch(generated.games, session.analysis, session.profile, payload.weights ?? null);
  const scoringMs = now() - scoringStarted;
  return {
    generated: generated.games.length,
    generationTime: Math.round(generationMs),
    scoringTime: Math.round(scoringMs),
    perGameMs: generated.games.length ? generationMs / generated.games.length : 0,
    total: Math.round(generationMs + scoringMs),
    sample: scored.slice(0, 3).map((item) => ({ numbers: item.numbers, score: item.score })),
    hardware: payload.hardware ?? null,
  };
}

/** Score de uma combinacao especifica (analisador ao vivo). */
export async function scoreCombination(gameId, numbers, weights) {
  const session = requireSession(gameId);
  const check = validateGame(numbers, session.profile, { ticketSize: numbers.length });
  if (!check.valid) throw new Error(check.errors.join('; '));
  return computeScore(check.numbers, session.analysis, session.profile, weights);
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                          */
/* ------------------------------------------------------------------ */

const HANDLERS = {
  [WORKER_MESSAGES.INIT]: handleInit,
  [WORKER_MESSAGES.ANALYZE]: handleAnalyze,
  [WORKER_MESSAGES.GENERATE]: handleGenerate,
  [WORKER_MESSAGES.RANK]: handleRank,
  [WORKER_MESSAGES.BACKTEST]: handleBacktest,
  [WORKER_MESSAGES.MONTE_CARLO]: handleMonteCarlo,
  [WORKER_MESSAGES.CLOSE]: handleClose,
  [WORKER_MESSAGES.BENCHMARK]: handleBenchmark,
};

/**
 * Executa uma requisicao do protocolo.
 * @param {{id:string, type:string, payload:object}} request
 * @param {{report?:Function}} [options]
 */
export async function execute(request, options = {}) {
  const started = now();
  const ctx = {
    requestId: request.id,
    report: options.report ?? (() => {}),
  };
  const handler = HANDLERS[request.type];
  if (!handler) {
    return {
      id: request.id,
      type: request.type,
      success: false,
      error: { code: 'E_WORKER', message: `tipo desconhecido: ${request.type}` },
      metrics: { elapsedMs: Math.round(now() - started), algorithmVersion: ALGORITHM_VERSION },
    };
  }
  try {
    const data = await handler(request.payload ?? {}, ctx);
    return {
      id: request.id,
      type: request.type,
      success: true,
      data,
      error: null,
      metrics: {
        elapsedMs: Math.round(now() - started),
        algorithmVersion: ALGORITHM_VERSION,
        seeded: Boolean(request.payload?.seed),
      },
    };
  } catch (error) {
    return {
      id: request.id,
      type: request.type,
      success: false,
      error: { code: 'E_WORKER', message: error?.message ?? String(error) },
      metrics: { elapsedMs: Math.round(now() - started), algorithmVersion: ALGORITHM_VERSION },
    };
  } finally {
    cancelled.delete(request.id);
  }
}

export function cancelRequest(requestId) {
  if (requestId) cancelled.add(requestId);
}

export function listSessions() {
  return [...sessions.keys()];
}

/* ------------------------------------------------------------------ */
/* Registro no contexto Worker                                         */
/* ------------------------------------------------------------------ */

const isWorkerContext =
  typeof self !== 'undefined' &&
  typeof self.postMessage === 'function' &&
  typeof document === 'undefined' &&
  typeof importScripts === 'function';

if (isWorkerContext) {
  self.addEventListener('message', async (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    if (message.type === WORKER_MESSAGES.CANCEL) {
      cancelRequest(message.payload?.targetId ?? message.targetId);
      return;
    }

    if (message.type === WORKER_MESSAGES.INIT && message.payload?.dataset) {
      try {
        const data = await handleInit(message.payload);
        self.postMessage({
          id: message.id,
          type: message.type,
          success: true,
          data,
          error: null,
          metrics: { algorithmVersion: ALGORITHM_VERSION },
        });
      } catch (error) {
        self.postMessage({
          id: message.id,
          type: message.type,
          success: false,
          error: { code: 'E_WORKER', message: error.message },
          metrics: { algorithmVersion: ALGORITHM_VERSION },
        });
      }
      return;
    }

    const response = await execute(message, {
      report: (progress) =>
        self.postMessage({
          id: message.id,
          type: WORKER_MESSAGES.PROGRESS,
          progress: progress.percent ?? (progress.total ? (progress.processed / progress.total) * 100 : 0),
          processed: progress.processed ?? null,
          total: progress.total ?? null,
          elapsed: progress.elapsed ?? null,
        }),
    });
    self.postMessage(response);
  });
}
