/**
 * Formatacao de valores para a interface (pt-BR) e utilidades de texto.
 * Nao toca no DOM.
 */

const numberFormat = new Intl.NumberFormat('pt-BR');
const decimalFormat = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const currencyFormat = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function integer(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return numberFormat.format(Number(value));
}

export function decimal(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return '-';
  if (digits === 2) return decimalFormat.format(Number(value));
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value));
}

export function currency(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return currencyFormat.format(Number(value));
}

/** Recebe fracao 0..1 e devolve percentual legivel. */
export function percent(fraction, digits = 1) {
  if (!Number.isFinite(Number(fraction))) return '-';
  return `${decimal(Number(fraction) * 100, digits)}%`;
}

/** Recebe valor ja em pontos percentuais. */
export function percentValue(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return '-';
  return `${decimal(value, digits)}%`;
}

export function signed(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return '-';
  const formatted = decimal(value, digits);
  return Number(value) > 0 ? `+${formatted}` : formatted;
}

export function compactNumber(value) {
  if (!Number.isFinite(Number(value))) return '-';
  const number = Number(value);
  if (Math.abs(number) >= 1e9) return `${decimal(number / 1e9, 1)} bi`;
  if (Math.abs(number) >= 1e6) return `${decimal(number / 1e6, 1)} mi`;
  if (Math.abs(number) >= 1e3) return `${decimal(number / 1e3, 1)} mil`;
  return integer(number);
}

export function date(value) {
  if (!value) return '-';
  const parsed = typeof value === 'string' ? new Date(`${value.slice(0, 10)}T12:00:00Z`) : new Date(value);
  if (Number.isNaN(parsed.getTime())) return '-';
  return parsed.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

export function dateTime(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '-';
  return parsed.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function duration(milliseconds) {
  if (!Number.isFinite(Number(milliseconds))) return '-';
  const ms = Number(milliseconds);
  if (ms < 1000) return `${integer(Math.round(ms))} ms`;
  if (ms < 60000) return `${decimal(ms / 1000, 2)} s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes} min ${seconds}s`;
}

export function bytes(value) {
  if (!Number.isFinite(Number(value))) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Number(value);
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${decimal(size, index === 0 ? 0 : 1)} ${units[index]}`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Remove controles e limita tamanho de texto importado. */
export function sanitizeText(value, limit = 500) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, limit)
    .trim();
}

export function plural(count, singular, pluralForm) {
  return `${integer(count)} ${count === 1 ? singular : pluralForm}`;
}

export function truncate(value, limit = 80) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Pontuacao visual do score (0-100) em categoria textual. */
export function scoreTier(score) {
  if (!Number.isFinite(Number(score))) return { label: '-', tone: 'neutral' };
  const value = Number(score);
  if (value >= 85) return { label: 'Alta aderencia', tone: 'high' };
  if (value >= 70) return { label: 'Boa aderencia', tone: 'good' };
  if (value >= 50) return { label: 'Aderencia media', tone: 'medium' };
  return { label: 'Baixa aderencia', tone: 'low' };
}
