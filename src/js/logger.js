/**
 * Logger unico da aplicacao. DEBUG fica desligado em producao.
 */

import { LOG_LEVELS } from './config.js';

const BUFFER_LIMIT = 200;
const buffer = [];
const listeners = new Set();

let currentLevel = LOG_LEVELS.WARN;

export function setLogLevel(value) {
  if (typeof value === 'number') {
    currentLevel = value;
    return;
  }
  const key = String(value ?? '').toUpperCase();
  currentLevel = LOG_LEVELS[key] ?? LOG_LEVELS.WARN;
}

function emit(levelName, message, details) {
  const entry = {
    level: levelName,
    message: typeof message === 'string' ? message : String(message),
    details: details === undefined ? null : details,
    at: new Date().toISOString(),
  };
  buffer.push(entry);
  if (buffer.length > BUFFER_LIMIT) buffer.shift();
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      /* listener com defeito nunca deve quebrar o log */
    }
  }
  return entry;
}

function write(levelName, weight, message, details) {
  if (weight < currentLevel) return null;
  const entry = emit(levelName, message, details);
  const consoleMethod =
    levelName === 'ERROR' ? 'error' : levelName === 'WARN' ? 'warn' : levelName === 'DEBUG' ? 'debug' : 'info';
  if (typeof console !== 'undefined' && typeof console[consoleMethod] === 'function') {
    console[consoleMethod](`[${levelName}] ${entry.message}`, details ?? '');
  }
  return entry;
}

export const logger = {
  debug: (message, details) => write('DEBUG', LOG_LEVELS.DEBUG, message, details),
  info: (message, details) => write('INFO', LOG_LEVELS.INFO, message, details),
  warn: (message, details) => write('WARN', LOG_LEVELS.WARN, message, details),
  error: (message, details) => write('ERROR', LOG_LEVELS.ERROR, message, details),
};

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Normaliza qualquer erro em {code, message, details}. */
export function toErrorInfo(error, fallbackCode = 'E_UNKNOWN') {
  if (!error) return { code: fallbackCode, message: 'erro desconhecido', details: null };
  if (error.code && error.message) return { code: error.code, message: error.message, details: error.details ?? null };
  return {
    code: fallbackCode,
    message: error.message ? String(error.message) : String(error),
    details: error.stack ? { stack: String(error.stack).split('\n').slice(0, 4).join(' | ') } : null,
  };
}

/** Cria um erro com codigo estruturado. */
export function appError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}
