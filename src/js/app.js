/**
 * Ponto de entrada da aplicacao: orquestra dados, Worker, persistencia, rotas e UI.
 */

import { ALGORITHM_VERSION, DEFAULT_SETTINGS, VIEWS, WORKER_MESSAGES } from './config.js';
import { getProfile } from './game-profiles.js';
import { DataLoader } from './data-loader.js';
import { db } from './db.js';
import { computeScore, normalizeWeights } from './scoring-engine.js';
import {
  buildAnalysisCSV,
  buildAnalysisJSON,
  buildBacktestCSV,
  buildGamesCSV,
  buildGamesJSON,
  buildGamesTXT,
  buildFilename,
  downloadFile,
  detectFormat,
  parseImportedText,
} from './export.js';
import { validateImportRecord } from './validator.js';
import {
  currentAnalysis,
  getSettings,
  getState,
  patchAnalysis,
  patchDataset,
  setBusy,
  setProgress,
  setSettings,
  setState,
  setStatus,
  subscribe,
} from './state.js';
import { workerClient } from './worker-client.js';
import { logger, setLogLevel, toErrorInfo } from './logger.js';
import { registerShortcuts } from './accessibility.js';
import { notifyError, notifyInfo, notifySuccess, notifyWarning, progressToast } from './notifications.js';
import {
  closeModal,
  initUI,
  render,
  setAnalyzerResult,
  setBacktestResult,
  setClosureResult,
  setGeneratedGames,
  setMonteCarloResult,
  updateProgressBar,
} from './ui.js';

const DB_GAMES = 'games';

const loader = new DataLoader({ db });

let currentTask = null;
let progressHandle = null;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

async function loadSettings() {
  try {
    const stored = await db.get('settings', 'app');
    if (!stored) return { ...DEFAULT_SETTINGS, weights: { ...DEFAULT_SETTINGS.weights } };
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      weights: { ...DEFAULT_SETTINGS.weights, ...(stored.weights ?? {}) },
    };
  } catch (error) {
    logger.warn('falha ao carregar configuracoes', { error: error.message });
    return { ...DEFAULT_SETTINGS, weights: { ...DEFAULT_SETTINGS.weights } };
  }
}

async function persistSettings(settings) {
  try {
    await db.put('settings', { id: 'app', ...settings, updatedAt: new Date().toISOString() });
  } catch (error) {
    logger.warn('falha ao salvar configuracoes', { error: error.message });
    notifyWarning('Nao foi possivel salvar as configuracoes neste navegador.');
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme ?? 'system';
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
  const resolved = theme === 'system' ? (media?.matches ? 'light' : 'dark') : theme;
  document.documentElement.dataset.resolvedTheme = resolved;
}

/* ------------------------------------------------------------------ */
/* Tarefas com progresso                                               */
/* ------------------------------------------------------------------ */

async function runTask(label, task, options = {}) {
  if (currentTask) {
    notifyWarning('Ja existe uma operacao em andamento.');
    return null;
  }
  setBusy(true);
  if (options.status) setStatus(options.status);
  currentTask = label;
  try {
    return await task();
  } catch (error) {
    const info = toErrorInfo(error, 'E_UNKNOWN');
    if (info.code !== 'E_CANCELLED') {
      logger.error(`${label} falhou`, info);
      notifyError(info.message, { title: 'Falha na operacao' });
    }
    return null;
  } finally {
    currentTask = null;
    setBusy(false);
    setProgress(null);
    progressHandle?.close();
    progressHandle = null;
    setStatus(deriveStatus());
    render();
  }
}

function deriveStatus() {
  const state = getState();
  if (!state.dataset[state.gameId]) return 'idle';
  if (!state.online) return 'offline';
  return 'ready';
}

function attachProgress(options = {}) {
  return (progress) => {
    setProgress(progress);
    updateProgressBar(progress);
    if (options.toast) {
      if (!progressHandle) progressHandle = progressToast(options.toast, () => cancelCurrentTask());
      progressHandle.update(progress.percent, `${Math.round(progress.percent)}% · ${progress.processed ?? 0}/${progress.total ?? 0}`);
    }
  };
}

function cancelCurrentTask() {
  if (!currentTask) return;
  const id = workerClient.lastRequestId;
  if (id) {
    workerClient.cancel(id);
    notifyInfo('Cancelamento solicitado.');
  }
}

/* ------------------------------------------------------------------ */
/* Datasets                                                            */
/* ------------------------------------------------------------------ */

async function initializeAnalysis(gameId, dataset) {
  const payload = { gameId, dataset, window: getSettings().historyLimit ?? 0 };
  const { data } = await workerClient.request(WORKER_MESSAGES.INIT, payload, { timeoutMs: 120000 });
  setState({ workerReady: workerClient.usingWorker });
  patchAnalysis(gameId, data.analysis, {
    score: null,
    generatedAt: new Date().toISOString(),
    lastContest: data.lastContest,
    hash: data.hash,
  });
  return data;
}

async function loadGame(gameId, options = {}) {
  const profile = getProfile(gameId);
  setStatus('loading');
  render();

  const result = await runTask(
    'carregar dados',
    async () => {
      const loaded = await loader.load(profile, { force: options.force });
      patchDataset(gameId, {
        ...DataLoader.describe(loaded.dataset, profile),
        loadedAt: new Date().toISOString(),
        origin: loaded.origin,
      });
      await initializeAnalysis(gameId, loaded.dataset);
      return loaded;
    },
    { status: 'loading' },
  );

  if (result) {
    const state = getState();
    setStatus(state.online ? 'ready' : 'offline');
    if (options.force) {
      notifySuccess(
        `Dados atualizados: concurso ${result.dataset.lastContest} (${result.dataset.draws.length} concursos).`,
        { title: profile.name },
      );
    }
    if (result.warnings?.length) {
      logger.warn('avisos no dataset', { warnings: result.warnings });
    }
    await notifyNewContest(profile, result.dataset);
  } else {
    setStatus('error');
  }
  render();
}

async function notifyNewContest(profile, dataset) {
  const state = getState();
  const games = state.games.filter((game) => game.game === profile.id);
  if (games.length === 0) return;
  const lastDraw = dataset.draws[dataset.draws.length - 1];
  if (!lastDraw) return;
  const tierHits = new Set(profile.prizeRules.tiers.map((tier) => tier.hits));
  let winners = 0;
  for (const game of games) {
    const hits = game.numbers.filter((number) => lastDraw.numbers.includes(number)).length;
    if (tierHits.has(hits)) winners += 1;
  }
  if (winners > 0) {
    notifySuccess(`${winners} jogo(s) salvo(s) atingiram faixa premiada no concurso ${lastDraw.contest}.`, {
      title: 'Conferencia automatica',
      timeout: 12000,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Jogos salvos                                                        */
/* ------------------------------------------------------------------ */

async function loadGames(gameId) {
  try {
    const all = await db.getAll(DB_GAMES);
    const games = all
      .filter((game) => game.game === gameId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    setState({ games });
  } catch (error) {
    logger.warn('falha ao carregar jogos', { error: error.message });
    setState({ games: [] });
  }
}

async function saveGames(games) {
  if (!games || games.length === 0) {
    notifyWarning('Nenhum jogo para salvar.');
    return;
  }
  const state = getState();
  const profile = getProfile(state.gameId);
  const existingKeys = new Set(state.games.map((game) => game.numbers.join(',')));
  const records = [];
  let duplicates = 0;
  for (const game of games) {
    const check = validateImportRecord({ numbers: game.numbers }, profile);
    if (!check.valid) continue;
    const key = check.numbers.join(',');
    if (existingKeys.has(key)) {
      duplicates += 1;
      continue;
    }
    existingKeys.add(key);
    records.push({
      game: profile.id,
      numbers: check.numbers,
      score: Number.isFinite(game.score) ? game.score : null,
      source: game.source ?? 'app',
      tags: game.tags ?? [],
      notes: game.notes ?? '',
      createdAt: new Date().toISOString(),
      algorithmVersion: ALGORITHM_VERSION,
    });
  }
  if (records.length === 0) {
    notifyWarning(duplicates > 0 ? 'Todos os jogos ja estavam salvos.' : 'Nenhum jogo valido para salvar.');
    return;
  }
  try {
    await db.bulkPut(DB_GAMES, records);
  } catch (error) {
    notifyError(`Falha ao salvar jogos: ${error.message}`);
    return;
  }
  await loadGames(profile.id);
  render();
  notifySuccess(`${records.length} jogo(s) salvo(s).${duplicates ? ` ${duplicates} duplicado(s) ignorado(s).` : ''}`);
}

async function deleteGame(id) {
  await db.delete(DB_GAMES, id);
  await loadGames(getState().gameId);
  render();
  notifySuccess('Jogo excluido.');
}

async function deleteGames(ids) {
  for (const id of ids) await db.delete(DB_GAMES, id);
  await loadGames(getState().gameId);
  render();
  notifySuccess(`${ids.length} jogo(s) excluido(s).`);
}

/* ------------------------------------------------------------------ */
/* Importacao / exportacao                                             */
/* ------------------------------------------------------------------ */

async function importGames({ text, filename }) {
  const state = getState();
  const profile = getProfile(state.gameId);
  if (typeof text !== 'string' || text.length === 0) {
    notifyWarning('Arquivo vazio.');
    return;
  }
  const format = detectFormat(filename, text);
  const parsed = parseImportedText(text, profile, format);
  const valid = [];
  const invalid = [...parsed.invalid];
  for (const record of parsed.games) {
    const check = validateImportRecord(record, profile);
    if (check.valid) valid.push({ numbers: check.numbers, source: 'import', tags: check.meta.tags, notes: check.meta.notes });
    else invalid.push({ line: null, reason: check.errors.join('; ') });
  }
  if (valid.length === 0) {
    notifyError(`Nenhum jogo valido encontrado (${invalid.length} invalido(s)).`);
    return;
  }
  await saveGames(valid);
  notifyInfo(
    `Importacao: ${valid.length} valido(s), ${invalid.length} invalido(s) (${format.toUpperCase()}).`,
    { title: 'Importacao concluida' },
  );
}

function exportGames(format, games) {
  const state = getState();
  const profile = getProfile(state.gameId);
  if (!games || games.length === 0) {
    notifyWarning('Nenhum jogo para exportar.');
    return;
  }
  const meta = { gameId: profile.id, algorithmVersion: ALGORITHM_VERSION, disclaimer: 'Analises estatisticas sem garantia de premiacao.' };
  let content;
  let extension;
  let mime;
  if (format === 'csv') {
    content = buildGamesCSV(games);
    extension = 'csv';
    mime = 'text/csv;charset=utf-8';
  } else if (format === 'txt') {
    content = buildGamesTXT(games);
    extension = 'txt';
    mime = 'text/plain;charset=utf-8';
  } else {
    content = buildGamesJSON(games, meta);
    extension = 'json';
    mime = 'application/json;charset=utf-8';
  }
  const result = downloadFile(buildFilename(`jogos-${profile.id}`, extension), content, mime);
  notifySuccess(`Exportado: ${result.filename}`);
}

function exportBacktest(result) {
  if (!result) {
    notifyWarning('Nenhum resultado para exportar.');
    return;
  }
  downloadFile(buildFilename('backtest', 'csv'), buildBacktestCSV(result), 'text/csv;charset=utf-8');
  notifySuccess('Backtest exportado em CSV.');
}

function exportAnalysis(format = 'json') {
  const state = getState();
  const analysis = currentAnalysis(state);
  if (!analysis) {
    notifyWarning('Nenhuma analise disponivel.');
    return;
  }
  const meta = state.dataset[state.gameId];
  if (format === 'csv') {
    downloadFile(buildFilename(`analise-${state.gameId}`, 'csv'), buildAnalysisCSV(analysis), 'text/csv;charset=utf-8');
    notifySuccess('Analise exportada em CSV.');
    return;
  }
  const content = buildAnalysisJSON(analysis, {
    algorithmVersion: ALGORITHM_VERSION,
    datasetVersion: 1,
    datasetHash: meta?.hash,
    lastContest: meta?.lastContest,
    gameId: state.gameId,
  });
  downloadFile(buildFilename(`analise-${state.gameId}`, 'json'), content, 'application/json;charset=utf-8');
  notifySuccess('Analise exportada em JSON.');
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

async function loadPresets(gameId) {
  try {
    const presets = await db.byIndex('presets', 'game', gameId);
    setState({ presets });
  } catch (error) {
    logger.warn('falha ao carregar presets', { error: error.message });
  }
}

/* ------------------------------------------------------------------ */
/* Handlers da UI                                                      */
/* ------------------------------------------------------------------ */

const handlers = {
  onNavigate(view) {
    const valid = VIEWS.some((item) => item.id === view);
    setState({ view: valid ? view : 'dashboard' });
    render();
  },

  async onSelectGame(gameId) {
    const state = getState();
    if (!getProfile(gameId)) return;
    if (state.busy) {
      notifyWarning('Aguarde a operacao atual terminar.');
      return;
    }
    setState({ gameId, view: state.view === 'games' ? 'games' : state.view });
    setSettings({ gameId });
    await persistSettings({ ...getSettings(), gameId });
    await loadGames(gameId);
    await loadPresets(gameId);
    const cached = state.dataset[gameId];
    if (cached) {
      render();
      if (!currentAnalysis(getState())) {
        await loadGame(gameId);
      }
    } else {
      await loadGame(gameId);
    }
    render();
  },

  async onRefresh() {
    const state = getState();
    await loadGame(state.gameId, { force: true });
  },

  onToggleTheme() {
    const order = ['dark', 'light', 'system'];
    const current = getSettings().theme ?? 'system';
    const next = order[(order.indexOf(current) + 1) % order.length];
    setSettings({ theme: next });
    applyTheme(next);
    persistSettings({ ...getSettings(), theme: next });
    render();
    notifyInfo(`Tema: ${next === 'dark' ? 'escuro' : next === 'light' ? 'claro' : 'sistema'}`);
  },

  async onGenerate(params) {
    const state = getState();
    if (!currentAnalysis(state)) {
      notifyWarning('Aguarde o carregamento da analise.');
      return;
    }
    const profile = getProfile(state.gameId);
    if (params.filters.fixed.length > params.size) {
      notifyError('Dezenas fixas excedem o tamanho do jogo.');
      return;
    }
    const result = await runTask('gerar jogos', async () => {
      const { data } = await workerClient.request(
        WORKER_MESSAGES.GENERATE,
        {
          gameId: profile.id,
          size: params.size,
          count: params.count,
          filters: params.filters,
          strategy: params.strategy,
          seed: params.seed,
          diversity: params.diversity,
        },
        { onProgress: attachProgress() },
      );
      return data;
    });
    if (!result) return;
    setGeneratedGames(result.games, {
      strategy: params.strategy,
      seed: params.seed || null,
      count: result.generated,
      truncated: result.truncated,
      attempts: result.attempts,
      seedUsed: result.seeded,
    });
    if (result.games.length === 0) {
      notifyWarning('Nenhum jogo passou pelos filtros. Verifique os limites.');
    } else {
      notifySuccess(`${result.games.length} jogo(s) gerados.${result.truncated ? ' (limitado pelos filtros)' : ''}`);
    }
  },

  async onRank(params) {
    const state = getState();
    if (!currentAnalysis(state)) {
      notifyWarning('Aguarde o carregamento da analise.');
      return;
    }
    const profile = getProfile(state.gameId);
    const result = await runTask('ranquear candidatos', async () => {
      const { data } = await workerClient.request(
        WORKER_MESSAGES.RANK,
        {
          gameId: profile.id,
          size: params.size,
          count: params.count,
          candidateCount: params.candidateCount,
          filters: params.filters,
          strategy: params.strategy,
          seed: params.seed,
          weights: params.weights,
          diversity: params.diversity,
        },
        { onProgress: attachProgress({ toast: 'Gerando e ranqueando' }) },
      );
      return data;
    });
    if (!result) return;
    setGeneratedGames(result.games, {
      strategy: params.strategy,
      seed: params.seed || null,
      count: result.games.length,
      generated: result.generated,
      seedUsed: result.seeded,
    });
    notifySuccess(`${result.games.length} jogo(s) ranqueados de ${result.generated} candidatos unicos.`);
  },

  async onCancel() {
    cancelCurrentTask();
  },

  async onSaveGames(games) {
    await saveGames(games);
  },

  async onDeleteGame(id) {
    await deleteGame(id);
  },

  async onDeleteGames(ids) {
    await deleteGames(ids);
  },

  async onScoreCombination(numbers) {
    const state = getState();
    const analysis = currentAnalysis(state);
    const profile = getProfile(state.gameId);
    if (!analysis) return;
    try {
      const result = computeScore(numbers, analysis, profile, getSettings().weights);
      setAnalyzerResult(result);
      setState({
        lastAnalysisMeta: {
          score: result.score,
          generatedAt: new Date().toISOString(),
          numbers: [...numbers],
          algorithmVersion: ALGORITHM_VERSION,
        },
      });
      render();
    } catch (error) {
      notifyError(error.message);
    }
  },

  async onBacktest(params) {
    const state = getState();
    const profile = getProfile(state.gameId);
    if (params.games.length === 0) {
      notifyWarning('Nenhum jogo selecionado para o backtest.');
      return;
    }
    const result = await runTask('executar backtest', async () => {
      const { data } = await workerClient.request(WORKER_MESSAGES.BACKTEST, {
        gameId: profile.id,
        games: params.games,
        window: params.window === 0 ? null : params.window,
        cost: params.cost,
      });
      return data;
    });
    if (!result) return;
    setBacktestResult(result);
    notifySuccess(`Backtest concluido: media de ${result.averageHits.toFixed(3)} acertos por jogo.`);
  },

  async onMonteCarlo(params) {
    const state = getState();
    const profile = getProfile(state.gameId);
    if (params.games.length === 0) {
      notifyWarning('Nenhum jogo selecionado para a simulacao.');
      return;
    }
    const result = await runTask(
      'simulacao Monte Carlo',
      async () => {
        const { data } = await workerClient.request(
          WORKER_MESSAGES.MONTE_CARLO,
          {
            gameId: profile.id,
            games: params.games,
            simulations: params.simulations,
            window: params.window,
            cost: params.cost,
            seed: getSettings().seed || null,
          },
          { onProgress: attachProgress({ toast: 'Simulacao Monte Carlo' }) },
        );
        return data;
      },
      { status: 'updating' },
    );
    if (!result) return;
    if (result.cancelled) {
      notifyInfo('Simulacao cancelada.');
      return;
    }
    setMonteCarloResult(result);
    notifySuccess(`${result.completed} simulacoes concluidas em ${(result.elapsedMs / 1000).toFixed(1)}s.`);
  },

  async onClosure(params) {
    const state = getState();
    const profile = getProfile(state.gameId);
    if (params.base.length < params.size) {
      notifyWarning('Conjunto base menor que o tamanho do jogo.');
      return;
    }
    const result = await runTask('gerar fechamento', async () => {
      const { data } = await workerClient.request(WORKER_MESSAGES.CLOSE, {
        gameId: profile.id,
        base: params.base,
        size: params.size,
        maxGames: params.maxGames,
        seed: params.seed,
      });
      return data;
    });
    if (!result) return;
    setClosureResult(result);
    notifySuccess(`Fechamento: ${result.generated} jogo(s), cobertura de ${(result.coverage.ratio * 100).toFixed(1)}% dos pares.`);
  },

  async onImportGames({ text, filename }) {
    await importGames({ text, filename });
  },

  async onExportGames(format, games) {
    exportGames(format, games);
  },

  async onExportBacktest(result) {
    exportBacktest(result);
  },

  async onSaveSettings(patch) {
    const state = getState();
    const next = { ...getSettings(), ...patch };
    next.weights = normalizeWeights(patch.weights ?? next.weights);
    const normalizedWeights = {
      cycle: Math.round(next.weights.cycle * 1000) / 10,
      repetition: Math.round(next.weights.repetition * 1000) / 10,
      delay: Math.round(next.weights.delay * 1000) / 10,
      structure: Math.round(next.weights.structure * 1000) / 10,
    };
    next.weights = normalizedWeights;
    setSettings(next);
    await persistSettings(next);
    applyTheme(next.theme);
    if (next.gameId !== state.gameId) {
      await handlers.onSelectGame(next.gameId);
    } else {
      render();
      if (next.historyLimit !== state.settings.historyLimit) {
        await handlers.onSetAnalysisWindow(next.historyLimit);
      }
    }
    notifySuccess('Configuracoes salvas.');
  },

  async onSavePreset(name, filters) {
    const state = getState();
    if (!name) {
      notifyWarning('Informe um nome para o preset.');
      return;
    }
    await db.put('presets', {
      game: state.gameId,
      name,
      filters,
      createdAt: new Date().toISOString(),
    });
    await loadPresets(state.gameId);
    render();
    notifySuccess('Preset salvo.');
  },

  async onDeletePreset(id) {
    await db.delete('presets', id);
    await loadPresets(getState().gameId);
    render();
    notifySuccess('Preset excluido.');
  },

  async onClearCache() {
    const state = getState();
    const profile = getProfile(state.gameId);
    await loader.clearCache(profile);
    if ('caches' in window) {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key.includes('lottery-engine')).map((key) => caches.delete(key)));
      } catch (error) {
        logger.warn('falha ao limpar caches do service worker', { error: error.message });
      }
    }
    notifySuccess('Cache local removido. Os dados serao baixados novamente.');
    await loadGame(state.gameId);
  },

  async onBenchmark(params) {
    const state = getState();
    if (!currentAnalysis(state)) return null;
    const profile = getProfile(state.gameId);
    const result = await runTask('benchmark', async () => {
      const { data } = await workerClient.request(WORKER_MESSAGES.BENCHMARK, {
        gameId: profile.id,
        size: params.size,
        count: params.count,
        seed: 'benchmark',
      });
      return data;
    });
    return result;
  },

  async onSetAnalysisWindow(windowSize) {
    const state = getState();
    const profile = getProfile(state.gameId);
    const result = await runTask('recalcular analise', async () => {
      const { data } = await workerClient.request(WORKER_MESSAGES.ANALYZE, {
        gameId: profile.id,
        window: windowSize,
      });
      return data;
    });
    if (!result) return;
    patchAnalysis(state.gameId, result.analysis, {
      generatedAt: new Date().toISOString(),
      window: windowSize,
      lastContest: result.analysis.lastContest,
    });
    await persistSettings({ ...getSettings(), historyLimit: windowSize });
    render();
    notifySuccess(`Analise recalculada (${windowSize === 0 ? 'historico completo' : `ultimos ${windowSize} concursos`}).`);
  },

  async onExportAnalysis(format) {
    exportAnalysis(format);
  },
};

/* ------------------------------------------------------------------ */
/* Rotas                                                               */
/* ------------------------------------------------------------------ */

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '').split('?')[0];
  const view = VIEWS.some((item) => item.id === raw) ? raw : 'dashboard';
  return view;
}

function initRouter() {
  const apply = () => {
    const view = parseRoute();
    getState();
    setState({ view });
    render();
    document.getElementById('main')?.focus({ preventScroll: true });
  };
  window.addEventListener('hashchange', apply);
  apply();
}

/* ------------------------------------------------------------------ */
/* Service Worker                                                      */
/* ------------------------------------------------------------------ */

async function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    logger.info('Service Worker indisponivel');
    return;
  }
  if (location.protocol === 'file:') return;
  try {
    const registration = await navigator.serviceWorker.register(new URL('./sw.js', document.baseURI).href, {
      scope: './',
    });
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          notifyInfo('Nova versao disponivel. Recarregue para atualizar.', {
            title: 'Atualizacao',
            timeout: 12000,
            action: { label: 'Recarregar', onClick: () => location.reload() },
          });
        }
      });
    });
  } catch (error) {
    logger.warn('falha ao registrar Service Worker', { error: error.message });
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  setStatus('loading');
  try {
    await db.open();
    setState({ storageMode: db.available ? 'indexeddb' : 'memory' });
    if (!db.available) {
      notifyWarning('IndexedDB indisponivel: os jogos ficarao apenas nesta sessao.', { title: 'Armazenamento' });
    }
  } catch (error) {
    logger.error('falha ao abrir banco', { error: error.message });
  }

  const settings = await loadSettings();
  setLogLevel(settings.logLevel ?? 'WARN');
  setSettings(settings);
  setState({ theme: settings.theme, advancedMode: settings.advancedMode, gameId: settings.gameId });
  applyTheme(settings.theme);

  subscribe((state, patch) => {
    document.documentElement.dataset.state = state.status;
    const keys = Object.keys(patch ?? {});
    // Progresso nao dispara re-render completo (apenas a barra e atualizada).
    if (keys.length === 1 && keys[0] === 'progress') return;
    scheduleRender();
  });

  initUI(handlers);
  initRouter();
  registerShortcuts(
    Object.fromEntries(VIEWS.map((view, index) => [String(index + 1), () => {
      if (location.hash !== `#/${view.id}`) location.hash = `#/${view.id}`;
    }])),
  );

  window.addEventListener('online', () => {
    setState({ online: true });
    setStatus('ready');
    renderChromeSafe();
    notifyInfo('Conexao restabelecida.');
    handlers.onRefresh();
  });
  window.addEventListener('offline', () => {
    setState({ online: false });
    setStatus('offline');
    renderChromeSafe();
    notifyWarning('Sem conexao: a aplicacao continua funcionando com os dados locais.');
  });

  await loadGames(settings.gameId);
  await loadPresets(settings.gameId);
  render();

  await loadGame(settings.gameId);
  registerServiceWorker();

  window.addEventListener('beforeunload', () => {
    workerClient.terminate();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
}

let renderScheduled = false;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderChromeSafe();
  });
}

function renderChromeSafe() {
  try {
    render();
  } catch (error) {
    logger.warn('falha ao renderizar', { error: error.message });
  }
}

// Sobe a aplicacao no navegador. Em Node (testes) o modulo apenas exporta handlers.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    boot().catch((error) => {
      logger.error('falha na inicializacao', { error: error.message });
      notifyError(`Falha ao iniciar: ${error.message}`);
    });
  });
}

export { handlers };
