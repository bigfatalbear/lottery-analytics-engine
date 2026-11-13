/**
 * Graficos em SVG puro (sem dependencias) e montagem de strings seguras.
 * Todas as funcoes recebem dados numericamente validados e retornam markup estatico.
 */

import { escapeHtml } from './formatter.js';

const TONES = ['accent', 'positive', 'warning', 'negative', 'muted'];

function clampNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Grafico de barras verticais.
 * @param {Array<{label:string|number, value:number, tone?:string, hint?:string}>} items
 */
export function barChart(items, options = {}) {
  const data = Array.isArray(items) ? items.slice(0, options.limit ?? 60) : [];
  if (data.length === 0) return emptyChart('Sem dados para exibir');
  const height = options.height ?? 160;
  const barWidth = options.barWidth ?? 18;
  const gap = options.gap ?? 6;
  const paddingTop = 12;
  const paddingBottom = 22;
  const width = data.length * (barWidth + gap) + gap;
  const max = Math.max(...data.map((item) => clampNumber(item.value)), 1);
  const chartHeight = height - paddingTop - paddingBottom;
  const format = options.format ?? ((value) => String(value));

  const bars = data
    .map((item, index) => {
      const value = clampNumber(item.value);
      const barHeight = Math.max(1, (value / max) * chartHeight);
      const x = gap + index * (barWidth + gap);
      const y = paddingTop + chartHeight - barHeight;
      const tone = TONES.includes(item.tone) ? item.tone : options.tone ?? 'accent';
      const label =
        index % (options.labelEvery ?? 1) === 0
          ? `<text class="chart-label" x="${x + barWidth / 2}" y="${height - 6}" text-anchor="middle">${escapeHtml(item.label)}</text>`
          : '';
      return `<g class="chart-bar chart-bar-${tone}" data-index="${index}">
        <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="3"></rect>
        <title>${escapeHtml(item.hint ?? `${item.label}: ${format(value)}`)}</title>
        ${label}
      </g>`;
    })
    .join('');

  const axis = `<line class="chart-axis" x1="0" y1="${paddingTop + chartHeight}" x2="${width}" y2="${paddingTop + chartHeight}"></line>`;
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.ariaLabel ?? 'Grafico de barras')}" preserveAspectRatio="xMidYMid meet">${axis}${bars}</svg>`;
}

/** Histograma com faixas continuas. */
export function histogram(data, options = {}) {
  const items = (Array.isArray(data) ? data : []).map((item) => ({
    label: options.formatLabel ? options.formatLabel(item.value) : String(item.value),
    value: item.count,
    hint: `${options.formatLabel ? options.formatLabel(item.value) : item.value}: ${item.count}`,
  }));
  return barChart(items, { ...options, ariaLabel: options.ariaLabel ?? 'Histograma', height: options.height ?? 150, barWidth: 22 });
}

/** Anel de score 0-100. */
export function scoreRing(score, options = {}) {
  const size = options.size ?? 96;
  const stroke = options.stroke ?? 9;
  const value = Math.max(0, Math.min(100, clampNumber(score)));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (value / 100) * circumference;
  const tone = value >= 85 ? 'high' : value >= 70 ? 'good' : value >= 50 ? 'medium' : 'low';
  return `<svg class="score-ring score-ring-${tone}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Score ${value.toFixed(0)} de 100">
    <circle class="score-ring-track" cx="${size / 2}" cy="${size / 2}" r="${radius}" stroke-width="${stroke}" fill="none"></circle>
    <circle class="score-ring-value" cx="${size / 2}" cy="${size / 2}" r="${radius}" stroke-width="${stroke}" fill="none"
      stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-linecap="round"
      transform="rotate(-90 ${size / 2} ${size / 2})"></circle>
    <text class="score-ring-text" x="50%" y="50%" text-anchor="middle" dominant-baseline="central">${value.toFixed(0)}</text>
  </svg>`;
}

/** Medidor horizontal usado em componentes do score. */
export function meter(value, options = {}) {
  const percentValue = Math.max(0, Math.min(100, clampNumber(value)));
  const tone = percentValue >= 85 ? 'high' : percentValue >= 70 ? 'good' : percentValue >= 50 ? 'medium' : 'low';
  return `<div class="meter meter-${tone}" role="img" aria-label="${percentValue.toFixed(0)} de 100">
    <div class="meter-fill" style="width:${percentValue.toFixed(1)}%"></div>
  </div>`;
}

/** Mini serie (sparkline). */
export function sparkline(values, options = {}) {
  const data = (Array.isArray(values) ? values : []).map((value) => clampNumber(value));
  if (data.length < 2) return '';
  const width = options.width ?? 160;
  const height = options.height ?? 40;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const points = data
    .map((value, index) => {
      const x = (index / (data.length - 1)) * width;
      const y = height - ((value - min) / span) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}"></polyline></svg>`;
}

/** Mapa de calor do volante (grade de dezenas). */
export function boardHeatmap(profile, cells, options = {}) {
  const size = options.cellSize ?? 30;
  const gap = options.gap ?? 4;
  const width = profile.board.cols * (size + gap) + gap;
  const height = profile.board.rows * (size + gap) + gap;
  const max = Math.max(...cells.map((cell) => clampNumber(cell.count)), 1);
  const selected = new Set(options.selected ?? []);
  const parts = [];
  for (const cell of cells) {
    const x = gap + cell.col * (size + gap);
    const y = gap + cell.row * (size + gap);
    const ratio = clampNumber(cell.count) / max;
    const opacity = (0.12 + ratio * 0.78).toFixed(2);
    const isSelected = selected.has(cell.number);
    parts.push(`<g class="heat-cell${isSelected ? ' is-selected' : ''}" data-number="${cell.number}">
      <rect x="${x}" y="${y}" width="${size}" height="${size}" rx="6" style="fill-opacity:${opacity}"></rect>
      <text x="${x + size / 2}" y="${y + size / 2}" text-anchor="middle" dominant-baseline="central">${String(cell.number).padStart(2, '0')}</text>
      <title>Dezena ${cell.number}: ${cell.count} aparicoes</title>
    </g>`);
  }
  return `<svg class="heatmap" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.ariaLabel ?? 'Mapa de calor do volante')}">${parts.join('')}</svg>`;
}

export function emptyChart(message) {
  return `<div class="chart-empty">${escapeHtml(message)}</div>`;
}

