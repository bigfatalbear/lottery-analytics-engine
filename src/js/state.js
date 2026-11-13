/**
 * Estado central minimo.
 * Separa estado persistente (settings, theme, pesos) de estado de execucao (view, busy, progresso).
 */

import { DEFAULT_SETTINGS } from './config.js';

const listeners = new Set();

const initialState = {
  ready: false,
  view: 'dashboard',
  gameId: DEFAULT_SETTINGS.gameId,
  settings: { ...DEFAULT_SETTINGS },
  dataset: {
    // gameId -> {status, lastContest, totalDraws, lastUpdated, source, hash}
    lotofacil: null,
    megasena: null,
  },
  analysis: {
    // gameId -> analise resumida
    lotofacil: null,
    megasena: null,
  },
  games: [],
  presets: [],
  lastAnalysisMeta: null,
  busy: false,
  progress: null,
  status: 'idle',
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  workerReady: false,
  storageMode: 'unknown',
  lastError: null,
  advancedMode: Boolean(DEFAULT_SETTINGS.advancedMode),
  theme: DEFAULT_SETTINGS.theme,
};

let state = { ...initialState };

export function getState() {
  return state;
}

export function getSettings() {
  return state.settings;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(patch) {
  for (const listener of listeners) {
    try {
      listener(state, patch);
    } catch (error) {
      if (typeof console !== 'undefined') console.error('listener de estado falhou', error);
    }
  }
}

export function setState(patch) {
  if (!patch || typeof patch !== 'object') return state;
  const next = { ...state, ...patch };
  state = next;
  notify(patch);
  return state;
}

export function patchDataset(gameId, data) {
  return setState({ dataset: { ...state.dataset, [gameId]: { ...(state.dataset[gameId] ?? {}), ...data } } });
}

export function patchAnalysis(gameId, analysis, meta = null) {
  return setState({
    analysis: { ...state.analysis, [gameId]: analysis },
    lastAnalysisMeta: meta,
  });
}

export function setSettings(patch) {
  const settings = { ...state.settings, ...patch };
  const next = { ...state, settings };
  if (patch.gameId) next.gameId = patch.gameId;
  if (patch.theme) next.theme = patch.theme;
  if (patch.advancedMode !== undefined) next.advancedMode = Boolean(patch.advancedMode);
  state = next;
  notify({ settings });
  return state;
}

export function setBusy(busy, progress = null) {
  return setState({ busy: Boolean(busy), progress });
}

export function setProgress(progress) {
  return setState({ progress });
}

export function setStatus(status) {
  return setState({ status });
}

/** Analise do jogo ativo (ou null). */
export function currentAnalysis(stateRef = state) {
  return stateRef.analysis[stateRef.gameId] ?? null;
}

