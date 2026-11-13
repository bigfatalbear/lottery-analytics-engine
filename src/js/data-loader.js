/**
 * Carregamento de datasets: rede -> validacao -> cache local -> fallback offline.
 * Mantem a aplicacao funcional sem conexao apos o primeiro acesso.
 */

import { appError, logger } from './logger.js';
import { validateDataset } from './validator.js';

const CACHE_KIND = 'dataset';

function cacheId(gameId) {
  return `dataset:${gameId}`;
}

function resolveUrl(path) {
  if (typeof document !== 'undefined' && document.baseURI) {
    return new URL(path, document.baseURI).href;
  }
  return path;
}

export class DataLoader {
  constructor(options = {}) {
    this.db = options.db ?? null;
    this.fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.timeoutMs = options.timeoutMs ?? 25000;
    this.memory = new Map();
  }

  /** Le do cache local (IndexedDB) ou da memoria. */
  async readCache(profile) {
    if (this.memory.has(profile.id)) return this.memory.get(profile.id);
    if (!this.db) return null;
    try {
      const record = await this.db.get('cache', cacheId(profile.id));
      if (!record) return null;
      const result = { dataset: record.payload, fetchedAt: record.fetchedAt, hash: record.payload?.hash ?? null };
      this.memory.set(profile.id, result);
      return result;
    } catch (error) {
      logger.warn('falha ao ler cache do dataset', { error: error.message });
      return null;
    }
  }

  async writeCache(profile, dataset) {
    const record = {
      id: cacheId(profile.id),
      kind: CACHE_KIND,
      game: profile.id,
      fetchedAt: new Date().toISOString(),
      payload: dataset,
    };
    this.memory.set(profile.id, { dataset, fetchedAt: record.fetchedAt, hash: dataset.hash ?? null });
    if (!this.db) return;
    try {
      await this.db.put('cache', record);
    } catch (error) {
      logger.warn('falha ao gravar cache do dataset', { error: error.message });
    }
  }

  async clearCache(profile) {
    this.memory.delete(profile.id);
    if (!this.db) return;
    try {
      await this.db.delete('cache', cacheId(profile.id));
    } catch (error) {
      logger.warn('falha ao limpar cache do dataset', { error: error.message });
    }
  }

  /** Cache HTTP: o Service Worker entrega stale-while-revalidate para ./data. */
  async fetchRemote(profile, options = {}) {
    if (!this.fetchImpl) throw appError('E_NETWORK', 'fetch indisponivel neste ambiente');
    const base = resolveUrl(profile.datasetFile);
    const url = options.force ? `${base}?v=${Date.now()}` : base;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        cache: 'no-cache',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw appError('E_NETWORK', `HTTP ${response.status} ao buscar ${profile.datasetFile}`);
      const payload = await response.json();
      return { payload, fetchedAt: new Date().toISOString() };
    } catch (error) {
      if (error.name === 'AbortError') throw appError('E_TIMEOUT', 'tempo esgotado ao buscar dados');
      if (error.code) throw error;
      throw appError('E_NETWORK', `nao foi possivel carregar ${profile.datasetFile}: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Carrega o dataset mais confiavel disponivel.
   * @param {object} profile
   * @param {{force?: boolean, signal?: AbortSignal, preferCache?: boolean}} [options]
   */
  async load(profile, options = {}) {
    const { force = false, preferCache = false } = options;
    const warnings = [];
    const cached = await this.readCache(profile);

    if (!force && cached?.dataset) {
      const check = validateDataset(cached.dataset, profile);
      if (check.usable) {
        if (!preferCache) {
          // Atualiza em segundo plano; devolve o cache imediatamente (offline-first).
          this.fetchAndStore(profile, cached).then((result) => {
            if (result?.dataset) {
              this.onUpdate?.(result);
            }
          });
        }
        return {
          dataset: { ...cached.dataset, draws: check.draws },
          origin: 'cache',
          fetchedAt: cached.fetchedAt,
          warnings,
          validation: check,
        };
      }
      warnings.push('cache local invalido; tentando rede');
    }

    try {
      const remote = await this.fetchRemote(profile, { force });
      const check = validateDataset(remote.payload, profile);
      if (!check.usable) {
        throw appError('E_DATASET_INVALID', 'dataset recebido nao possui concursos validos');
      }
      if (check.errors.length > 0) warnings.push(...check.errors);
      if (check.warnings.length > 0) warnings.push(...check.warnings);

      const dataset = { ...remote.payload, draws: check.draws };
      await this.writeCache(profile, dataset);
      return {
        dataset,
        origin: 'network',
        fetchedAt: remote.fetchedAt,
        warnings,
        validation: check,
      };
    } catch (error) {
      if (cached?.dataset) {
        const check = validateDataset(cached.dataset, profile);
        warnings.push('sem conexao: usando copia local do dataset');
        return {
          dataset: { ...cached.dataset, draws: check.draws },
          origin: 'cache',
          fetchedAt: cached.fetchedAt,
          warnings,
          validation: check,
          error,
        };
      }
      throw appError('E_NETWORK', `sem dataset disponivel e falha de rede: ${error.message}`, {
        cause: error.code ?? null,
      });
    }
  }

  /** Busca em rede e grava apenas se o resultado for mais recente e valido. */
  async fetchAndStore(profile, cached) {
    try {
      const remote = await this.fetchRemote(profile);
      const check = validateDataset(remote.payload, profile);
      if (!check.usable) return null;
      const incomingLast = check.statistics.lastContest ?? 0;
      const cachedLast = cached?.dataset?.lastContest ?? 0;
      if (incomingLast < cachedLast) {
        logger.warn('dataset remoto mais antigo que o cache; mantendo cache', { incomingLast, cachedLast });
        return null;
      }
      const dataset = { ...remote.payload, draws: check.draws };
      await this.writeCache(profile, dataset);
      return { dataset, validation: check, fetchedAt: remote.fetchedAt, origin: 'network' };
    } catch (error) {
      logger.warn('atualizacao em segundo plano falhou', { error: error.message });
      return null;
    }
  }

  /** Metadados do dataset (para header e dashboard). */
  static describe(dataset, profile) {
    if (!dataset) {
      return { status: 'empty', totalDraws: 0, lastContest: null, lastDate: null, lastUpdated: null, hash: null };
    }
    const draws = dataset.draws ?? [];
    return {
      status: dataset.datasetStatus ?? (draws.length ? 'partial' : 'empty'),
      totalDraws: draws.length,
      lastContest: dataset.lastContest ?? draws[draws.length - 1]?.contest ?? null,
      lastDate: draws[draws.length - 1]?.date ?? null,
      lastUpdated: dataset.lastUpdated ?? null,
      hash: dataset.hash ?? null,
      source: dataset.source ?? 'local',
      game: profile.id,
    };
  }
}
