/**
 * Camada de persistencia IndexedDB com fallback em memoria.
 * Nenhuma operacao bloqueia a interface: todas retornam Promises.
 */

import { DB } from './config.js';
import { appError, logger } from './logger.js';

const SCHEMA = {
  [DB.stores.games]: { keyPath: 'id', indexes: [{ name: 'game', keyPath: 'game' }, { name: 'createdAt', keyPath: 'createdAt' }] },
  [DB.stores.presets]: { keyPath: 'id', indexes: [{ name: 'game', keyPath: 'game' }] },
  [DB.stores.analyses]: { keyPath: 'id', indexes: [{ name: 'game', keyPath: 'game' }, { name: 'createdAt', keyPath: 'createdAt' }] },
  [DB.stores.settings]: { keyPath: 'id', indexes: [] },
  [DB.stores.cache]: { keyPath: 'id', indexes: [{ name: 'kind', keyPath: 'kind' }] },
  [DB.stores.metadata]: { keyPath: 'id', indexes: [] },
};

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('falha em requisicao IndexedDB'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('transacao falhou'));
    transaction.onabort = () => reject(transaction.error ?? new Error('transacao abortada'));
  });
}

export class Database {
  constructor(options = {}) {
    this.name = options.name ?? DB.name;
    this.version = options.version ?? DB.version;
    this.schema = options.schema ?? SCHEMA;
    this.db = null;
    this.memory = new Map();
    this.mode = 'unknown';
    this.error = null;
    this.opening = null;
  }

  get available() {
    return this.mode === 'indexeddb';
  }

  async open() {
    if (this.db) return this;
    if (this.opening) return this.opening;
    this.opening = this.#openInternal();
    try {
      await this.opening;
    } finally {
      this.opening = null;
    }
    return this;
  }

  async #openInternal() {
    if (typeof indexedDB === 'undefined') {
      this.#useFallback('IndexedDB indisponivel neste navegador');
      return this;
    }
    try {
      this.db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(this.name, this.version);
        request.onupgradeneeded = () => {
          const database = request.result;
          for (const [storeName, config] of Object.entries(this.schema)) {
            if (!database.objectStoreNames.contains(storeName)) {
              const store = database.createObjectStore(storeName, { keyPath: config.keyPath });
              for (const index of config.indexes) {
                store.createIndex(index.name, index.keyPath, { unique: false });
              }
            }
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('nao foi possivel abrir IndexedDB'));
        request.onblocked = () => reject(new Error('IndexedDB bloqueado por outra aba'));
      });
      this.db.onversionchange = () => {
        this.db?.close();
        this.db = null;
        this.mode = 'closed';
      };
      this.mode = 'indexeddb';
      logger.info('IndexedDB aberto', { name: this.name, version: this.version });
      return this;
    } catch (error) {
      this.#useFallback(error?.message ?? 'falha ao abrir IndexedDB');
      return this;
    }
  }

  #useFallback(reason) {
    this.mode = 'memory';
    this.error = reason;
    logger.warn('Persistencia em memoria ativada', { reason });
  }

  #memoryStore(storeName) {
    if (!this.memory.has(storeName)) this.memory.set(storeName, new Map());
    return this.memory.get(storeName);
  }

  #assertStore(storeName) {
    if (!Object.prototype.hasOwnProperty.call(this.schema, storeName)) {
      throw appError('E_STORAGE', `store desconhecido: ${storeName}`);
    }
  }

  async #tx(storeName, mode, operation) {
    this.#assertStore(storeName);
    await this.open();
    if (!this.db) {
      return operation(null);
    }
    const transaction = this.db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const result = await operation(store);
    await transactionDone(transaction);
    return result;
  }

  async put(storeName, value) {
    const record = { ...value };
    if (!record.id) record.id = crypto.randomUUID();
    return this.#tx(storeName, 'readwrite', async (store) => {
      if (!store) {
        this.#memoryStore(storeName).set(record.id, record);
        return record;
      }
      await requestToPromise(store.put(record));
      return record;
    });
  }

  async bulkPut(storeName, values) {
    const records = values.map((value) => ({ ...value, id: value.id ?? crypto.randomUUID() }));
    return this.#tx(storeName, 'readwrite', async (store) => {
      if (!store) {
        const target = this.#memoryStore(storeName);
        for (const record of records) target.set(record.id, record);
        return records.length;
      }
      for (const record of records) store.put(record);
      return records.length;
    });
  }

  async get(storeName, id) {
    return this.#tx(storeName, 'readonly', async (store) => {
      if (!store) return this.#memoryStore(storeName).get(id) ?? null;
      return (await requestToPromise(store.get(id))) ?? null;
    });
  }

  async getAll(storeName) {
    return this.#tx(storeName, 'readonly', async (store) => {
      if (!store) return [...this.#memoryStore(storeName).values()];
      return requestToPromise(store.getAll());
    });
  }

  async delete(storeName, id) {
    return this.#tx(storeName, 'readwrite', async (store) => {
      if (!store) return this.#memoryStore(storeName).delete(id);
      await requestToPromise(store.delete(id));
      return true;
    });
  }

  async clear(storeName) {
    return this.#tx(storeName, 'readwrite', async (store) => {
      if (!store) {
        this.#memoryStore(storeName).clear();
        return true;
      }
      await requestToPromise(store.clear());
      return true;
    });
  }

  async count(storeName) {
    return this.#tx(storeName, 'readonly', async (store) => {
      if (!store) return this.#memoryStore(storeName).size;
      return requestToPromise(store.count());
    });
  }

  async byIndex(storeName, indexName, value) {
    return this.#tx(storeName, 'readonly', async (store) => {
      if (!store) {
        return [...this.#memoryStore(storeName).values()].filter((record) => record[indexName] === value);
      }
      const index = store.index(indexName);
      return requestToPromise(index.getAll(value));
    });
  }

  /** Busca por predicado em memoria (dataset pequeno: jogos, presets). */
  async search(storeName, predicate, limit = 100) {
    const all = await this.getAll(storeName);
    return all.filter(predicate).slice(0, limit);
  }

  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.mode = 'closed';
    }
  }
}

/** Instancia unica usada pela aplicacao. */
export const db = new Database();
