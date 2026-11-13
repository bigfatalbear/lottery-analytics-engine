/**
 * Cliente do Worker: correlacao de requisicoes, progresso, cancelamento e fallback.
 * Todo processamento pesado passa por aqui.
 */

import { LIMITS, WORKER_MESSAGES } from './config.js';
import { appError, logger } from './logger.js';

let counter = 0;

export class WorkerClient {
  constructor(options = {}) {
    this.url = options.url ?? new URL('../workers/worker.js', import.meta.url).href;
    this.timeoutMs = options.timeoutMs ?? LIMITS.workerTimeoutMs;
    this.worker = null;
    this.pending = new Map();
    this.mode = 'idle';
    this.error = null;
    this.lastRequestId = null;
  }

  get usingWorker() {
    return this.mode === 'worker';
  }

  get available() {
    return this.mode !== 'unavailable';
  }

  #createWorker() {
    if (typeof Worker === 'undefined') {
      throw appError('E_WORKER_UNAVAILABLE', 'Web Worker indisponivel');
    }
    const worker = new Worker(this.url, { type: 'module', name: 'lottery-engine-worker' });
    worker.addEventListener('message', (event) => this.#handleMessage(event.data));
    worker.addEventListener('error', (event) => this.#handleFatal(event));
    worker.addEventListener('messageerror', (event) => this.#handleFatal(event));
    return worker;
  }

  #handleFatal(event) {
    const message = event?.message ?? 'falha no Web Worker';
    logger.error('worker falhou', { message });
    this.error = message;
    for (const [, entry] of this.pending) {
      entry.reject(appError('E_WORKER', message));
      entry.cancelProgress?.();
    }
    this.pending.clear();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.mode = 'unavailable';
  }

  #handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    const entry = this.pending.get(message.id);
    if (!entry) return;

    if (message.type === WORKER_MESSAGES.PROGRESS) {
      entry.onProgress?.({
        percent: message.progress ?? 0,
        processed: message.processed ?? null,
        total: message.total ?? null,
        elapsed: message.elapsed ?? null,
      });
      return;
    }

    this.pending.delete(message.id);
    entry.clearTimer?.();
    entry.cancelProgress?.();
    if (message.success) {
      entry.resolve({ data: message.data, metrics: message.metrics ?? null });
    } else {
      entry.reject(
        appError(message.error?.code ?? 'E_WORKER', message.error?.message ?? 'falha no processamento', message.error ?? null),
      );
    }
  }

  async #ensureWorker() {
    if (this.mode === 'worker' && this.worker) return this.worker;
    if (this.mode === 'fallback') return null;
    try {
      this.worker = this.#createWorker();
      this.mode = 'worker';
      return this.worker;
    } catch (error) {
      logger.warn('executando em modo fallback (sem Worker)', { error: error.message });
      this.mode = 'fallback';
      this.error = error.message;
      return null;
    }
  }

  /**
   * Envia uma requisicao ao motor.
   * @param {string} type
   * @param {object} payload
   * @param {{onProgress?:Function, timeoutMs?:number}} [options]
   */
  async request(type, payload, options = {}) {
    counter += 1;
    const id = `${Date.now().toString(36)}-${counter}`;
    this.lastRequestId = id;
    const onProgress = options.onProgress ?? null;
    const worker = await this.#ensureWorker();

    if (worker) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.cancel(id);
          reject(appError('E_TIMEOUT', 'tempo limite excedido no processamento'));
        }, options.timeoutMs ?? this.timeoutMs);

        this.pending.set(id, {
          resolve,
          reject,
          onProgress,
          clearTimer: () => clearTimeout(timer),
        });
        worker.postMessage({ id, type, payload });
      });
    }

    return this.#runFallback(id, type, payload, onProgress);
  }

  /** Executa o mesmo dispatcher na Main Thread (operacao limitada, com aviso). */
  async #runFallback(id, type, payload, onProgress) {
    const module = await import('../workers/worker.js');
    const response = await module.execute(
      { id, type, payload },
      {
        report: (progress) =>
          onProgress?.({
            percent: progress.percent ?? (progress.total ? (progress.processed / progress.total) * 100 : 0),
            processed: progress.processed ?? null,
            total: progress.total ?? null,
            elapsed: progress.elapsed ?? null,
          }),
      },
    );
    if (response.success) return { data: response.data, metrics: response.metrics, fallback: true };
    throw appError(response.error?.code ?? 'E_WORKER', response.error?.message ?? 'falha no processamento');
  }

  /** Solicita cancelamento cooperativo de uma requisicao em andamento. */
  cancel(id) {
    if (this.worker && this.mode === 'worker') {
      this.worker.postMessage({ id: `${id}-cancel`, type: WORKER_MESSAGES.CANCEL, payload: { targetId: id } });
      return true;
    }
    return false;
  }

  /** Encerra o Worker (usado no unload). */
  terminate() {
    for (const [, entry] of this.pending) entry.reject(appError('E_WORKER', 'worker encerrado'));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.mode = 'idle';
  }
}

/** Instancia unica (lazy). */
export const workerClient = new WorkerClient();
