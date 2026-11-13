/**
 * LOTTERY ANALYTICS ENGINE â€” configuracao global.
 * Modulo puro: pode ser importado por UI, Worker, Service Worker e scripts Node.
 */

export const APP = Object.freeze({
  name: 'LOTTERY ANALYTICS ENGINE',
  shortName: 'Lottery Analytics',
  version: '1.0.0',
  description:
    'Analise estatistica, geracao e simulacao de jogos de loteria com dados historicos oficiais.',
  language: 'pt-BR',
  repository: 'lottery-analytics-engine',
});

/** Versao do conjunto de algoritmos estatisticos. Toda analise registra este valor. */
export const ALGORITHM_VERSION = '1.0.0';

/** Versao do cache do Service Worker. Alterar invalida caches antigos. */
export const CACHE_VERSION = 'lottery-engine-v1';

export const DB = Object.freeze({
  name: 'LotteryAnalyticsDB',
  version: 1,
  stores: Object.freeze({
    games: 'games',
    presets: 'presets',
    analyses: 'analyses',
    settings: 'settings',
    cache: 'cache',
    metadata: 'metadata',
  }),
});

export const LOG_LEVELS = Object.freeze({ DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, SILENT: 99 });

export const DEFAULT_WEIGHTS = Object.freeze({
  cycle: 30,
  repetition: 25,
  delay: 20,
  structure: 25,
});

export const DEFAULT_SETTINGS = Object.freeze({
  gameId: 'lotofacil',
  theme: 'system',
  ticketSize: 15,
  generateCount: 10,
  monteCarloSimulations: 1000,
  monteCarloWindow: 50,
  historyLimit: 0,
  backtestWindow: 100,
  costPerTicket: 0,
  weights: { ...DEFAULT_WEIGHTS },
  animations: true,
  compactMode: false,
  advancedMode: false,
  seed: '',
  logLevel: 'WARN',
});

export const LIMITS = Object.freeze({
  /** Teto de candidatos gerados em uma unica operacao. */
  maxCandidates: 100000,
  /** Teto de jogos renderizados por pagina na UI. */
  pageSize: 25,
  /** Amostra maxima de concursos usada em Monte Carlo por simulacao. */
  maxMonteCarloDraws: 500,
  /** Numero de iteracoes entre pontos de checagem de cancelamento no Worker. */
  progressChunk: 200,
  /** Tempo maximo (ms) que um lote sincrono roda antes de ceder o event loop. */
  chunkBudgetMs: 40,
  /** Timeout padrao de operacoes do Worker (ms). */
  workerTimeoutMs: 180000,
  /** Tamanho maximo (bytes) de arquivo aceito na importacao. */
  maxImportBytes: 8 * 1024 * 1024,
  /** Concursos minimos para uma analise ser considerada estatisticamente utilizavel. */
  minDrawsForAnalysis: 30,
});

export const VIEWS = Object.freeze([
  { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
  { id: 'analysis', label: 'Analise', icon: 'chart' },
  { id: 'generator', label: 'Gerador', icon: 'spark' },
  { id: 'backtest', label: 'Backtest', icon: 'clock' },
  { id: 'montecarlo', label: 'Monte Carlo', icon: 'dice' },
  { id: 'closures', label: 'Fechamentos', icon: 'layers' },
  { id: 'games', label: 'Meus Jogos', icon: 'bookmark' },
  { id: 'settings', label: 'Configuracoes', icon: 'gear' },
]);

export const WORKER_MESSAGES = Object.freeze({
  INIT: 'INIT',
  ANALYZE: 'ANALYZE',
  GENERATE: 'GENERATE',
  RANK: 'RANK',
  BACKTEST: 'BACKTEST',
  MONTE_CARLO: 'MONTE_CARLO',
  CLOSE: 'CLOSE',
  BENCHMARK: 'BENCHMARK',
  CANCEL: 'CANCEL',
  PROGRESS: 'PROGRESS',
});

export const DISCLAIMER =
  'Este aplicativo realiza analises estatisticas e simulacoes com base em dados historicos. ' +
  'Loterias sao eventos aleatorios. Nenhuma analise, estrategia ou combinacao garante premiacao.';
