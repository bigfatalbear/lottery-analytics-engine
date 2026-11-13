/**
 * Camada de apresentacao: renderizacao das views, interacoes e modais.
 *
 * Regras:
 *  - nenhum HTML sem escape de dados dinamicos;
 *  - nenhum handler inline (CSP);
 *  - nenhum processamento pesado (tudo delegado ao Worker).
 */

import { ALGORITHM_VERSION, APP, DEFAULT_SETTINGS, DISCLAIMER, LIMITS, VIEWS } from './config.js';
import { STRATEGIES } from './combination-engine.js';
import { GAME_IDS, boardCell, getProfile } from './game-profiles.js';
import { currentAnalysis, getSettings, getState } from './state.js';
import { announcePolite, prefersReducedMotion, syncChipStates, trapFocus } from './accessibility.js';
import { barChart, boardHeatmap, emptyChart, histogram, meter, scoreRing, sparkline } from './charts.js';
import {
  compactNumber,
  date,
  dateTime,
  decimal,
  duration,
  escapeHtml,
  integer,
  percent,
  percentValue,
  plural,
  sanitizeText,
  scoreTier,
  signed,
  truncate,
} from './formatter.js';
import { notifyError, notifySuccess, notifyWarning, progressToast } from './notifications.js';
import { buildFilename, downloadFile } from './export.js';

const PAGE_SIZE = LIMITS.pageSize;

const local = {
  handlers: null,
  tab: { analysis: 'overview', generator: 'structure', games: 'list' },
  generated: { list: [], meta: null, strategy: null, selected: new Set(), page: 0, size: 15, kind: 'generate' },
  generator: { filters: null },
  analyzer: { numbers: [], result: null, weights: null },
  closure: { base: [], result: null },
  backtest: { result: null, source: 'generated', window: 100, cost: null },
  monteCarlo: { result: null, source: 'generated', simulations: 1000, window: 50 },
  gamesFilter: 'all',
  gamesPage: 0,
  gamesSelected: new Set(),
  frequencySort: 'asc',
  modalRelease: null,
  progressToast: null,
};

const TONES = { high: 'positive', good: 'accent', medium: 'warning', low: 'negative' };

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function esc(value) {
  return escapeHtml(value);
}

function el(id) {
  return document.getElementById(id);
}

function value(id, fallback = '') {
  const node = el(id);
  return node && typeof node.value === 'string' ? node.value : fallback;
}

function numeric(id, fallback = 0) {
  const parsed = Number.parseInt(value(id), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function numberValue(id, fallback = 0) {
  const parsed = Number.parseFloat(value(id));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function checked(id) {
  const node = el(id);
  return Boolean(node?.checked);
}

function badge(text, tone = 'muted') {
  return `<span class="badge badge-${tone}">${esc(text)}</span>`;
}

function balls(numbers, profile, options = {}) {
  const small = options.small ? ' ball-sm' : '';
  return `<span class="balls${options.className ? ` ${options.className}` : ''}" aria-label="Dezenas ${numbers.join(', ')}">${numbers
    .map((number) => `<span class="ball${small}">${String(number).padStart(2, '0')}</span>`)
    .join('')}</span>`;
}

function ballRow(numbers, profile) {
  return numbers.map((number) => `<span class="ball ball-sm">${String(number).padStart(2, '0')}</span>`).join('');
}

function statCard({ label, value: mainValue, hint = '', tone = '', icon = '' }) {
  return `<article class="stat${tone ? ` stat-${tone}` : ''}">
    <header class="stat-head">
      <span class="stat-label">${esc(label)}</span>
      ${icon ? `<span class="stat-icon" aria-hidden="true">${icon}</span>` : ''}
    </header>
    <strong class="stat-value">${esc(mainValue)}</strong>
    ${hint ? `<span class="stat-hint">${hint}</span>` : ''}
  </article>`;
}

function sectionHead(title, description = '', actions = '') {
  return `<header class="section-head">
    <div>
      <h2 class="section-title">${esc(title)}</h2>
      ${description ? `<p class="section-sub">${esc(description)}</p>` : ''}
    </div>
    ${actions ? `<div class="section-actions">${actions}</div>` : ''}
  </header>`;
}

function table(headers, rows, options = {}) {
  const head = headers.map((header) => `<th${header.numeric ? ' class="num"' : ''}>${esc(header.label ?? header)}</th>`).join('');
  const body = rows
    .map(
      (row) =>
        `<tr${row.attrs ?? ''}>${row.cells
          .map((cell) => `<td class="${cell.numeric ? 'num' : ''}${cell.className ? ` ${cell.className}` : ''}">${cell.html ?? esc(cell.text ?? '')}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return `<div class="table-wrap${options.className ? ` ${options.className}` : ''}">
    <table class="table">
      <thead><tr>${head}</tr></thead>
      <tbody>${body || `<tr><td colspan="${headers.length}" class="empty-cell">Nenhum registro.</td></tr>`}</tbody>
    </table>
  </div>`;
}

function progressBlock(progress) {
  if (!progress) return '';
  const percentDone = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  const filled = Math.round(percentDone / 5);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, 20 - filled))}`;
  const detail =
    progress.processed && progress.total
      ? `${integer(progress.processed)} / ${integer(progress.total)}`
      : `${decimal(percentDone, 1)}%`;
  return `<div class="progress-block" id="op-progress" data-percent="${percentDone}">
    <div class="progress"><div class="progress-fill" style="width:${percentDone}%"></div></div>
    <div class="progress-meta">
      <span class="progress-ascii" aria-hidden="true">${bar}</span>
      <span>${esc(detail)}</span>
      <span>${decimal(percentDone, 0)}%</span>
      ${progress.elapsed ? `<span>${esc(duration(progress.elapsed))}</span>` : ''}
      <button type="button" class="btn btn-ghost btn-xs" data-action="cancel-op">Cancelar</button>
    </div>
  </div>`;
}

function emptyState(title, message, action = '') {
  return `<div class="empty">
    <p class="empty-title">${esc(title)}</p>
    <p class="empty-text">${esc(message)}</p>
    ${action}
  </div>`;
}

function rangeField(prefix, key, label, min, max, current, hint = '') {
  const low = current?.min ?? min;
  const high = current?.max ?? max;
  return `<div class="filter-field">
    <label class="label" for="${prefix}-${key}-min">${esc(label)}</label>
    <div class="filter-inputs">
      <input class="input input-compact" type="number" id="${prefix}-${key}-min" name="${key}-min" min="${min}" max="${max}" value="${low}" aria-label="${esc(label)} minimo" />
      <span class="filter-sep">a</span>
      <input class="input input-compact" type="number" id="${prefix}-${key}-max" name="${key}-max" min="${min}" max="${max}" value="${high}" aria-label="${esc(label)} maximo" />
    </div>
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
  </div>`;
}

function volante(profile, selected, action, options = {}) {
  const set = new Set(selected);
  const cells = [];
  for (let number = profile.minNumber; number <= profile.maxNumber; number += 1) {
    const isSelected = set.has(number);
    cells.push(
      `<button type="button" class="volante-cell${isSelected ? ' is-selected' : ''}" data-action="${action}" data-number="${number}" aria-pressed="${isSelected}" aria-label="Dezena ${number}">${String(number).padStart(2, '0')}</button>`,
    );
  }
  return `<div class="volante" style="--cols:${profile.board.cols}" role="group" aria-label="Volante de dezenas">${cells.join('')}</div>`;
}

/* ------------------------------------------------------------------ */
/* Navegacao / chrome                                                  */
/* ------------------------------------------------------------------ */

const ICON_PATHS = {
  grid: '<rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1"/><rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1"/><rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1"/><rect x="8.9" y="8.9" width="4.6" height="4.6" rx="1"/>',
  chart: '<path d="M3 13V8"/><path d="M8 13V3.5"/><path d="M13 13V6"/><path d="M1.5 13h13"/>',
  spark: '<path d="M8 1.8l1.7 4.5 4.5 1.7-4.5 1.7L8 14.2 6.3 9.7 1.8 8l4.5-1.7z"/>',
  clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.3 1.5"/>',
  dice: '<rect x="2.3" y="2.3" width="11.4" height="11.4" rx="2.4"/><circle cx="5.8" cy="5.8" r="0.9" fill="currentColor" stroke="none"/><circle cx="10.2" cy="10.2" r="0.9" fill="currentColor" stroke="none"/>',
  layers: '<path d="M8 2.2l6 3-6 3-6-3z"/><path d="M2 9l6 3 6-3"/><path d="M2 12.2l6 3 6-3"/>',
  bookmark: '<path d="M4 2.2h8v11.6l-4-2.8-4 2.8z"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2"/>',
};

function iconSvg(name) {
  const path = ICON_PATHS[name] ?? ICON_PATHS.grid;
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

function navItems() {
  const { view } = getState();
  return VIEWS.map(
    (item) => `<a class="nav-item${view === item.id ? ' is-active' : ''}" href="#/${item.id}" data-action="navigate" data-view="${item.id}" ${view === item.id ? 'aria-current="page"' : ''}>
      <span class="nav-icon" aria-hidden="true">${iconSvg(item.icon)}</span>
      <span>${esc(item.label)}</span>
    </a>`,
  ).join('');
}

export function renderChrome() {
  const state = getState();
  const profile = getProfile(state.gameId);
  const meta = state.dataset[state.gameId];
  const nav = el('nav');
  if (nav) nav.innerHTML = navItems();

  for (const button of document.querySelectorAll('[data-action="select-game"]')) {
    const isActive = button.dataset.game === state.gameId;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  }

  const status = el('data-status');
  const statusText = el('data-status-text');
  if (status && statusText) {
    status.className = `status-pill status-${state.status}`;
    statusText.textContent = statusLabel(state.status);
  }

  const last = el('last-contest');
  if (last) {
    last.textContent = meta?.lastContest
      ? `Concurso ${integer(meta.lastContest)} · ${date(meta.lastDate)}`
      : 'Sem dados carregados';
  }

  const version = el('foot-version');
  if (version) version.textContent = `v${APP.version} · ${profile.shortName}`;
  const storage = el('foot-storage');
  if (storage) {
    storage.textContent =
      state.storageMode === 'indexeddb' ? 'IndexedDB ativo' : state.storageMode === 'memory' ? 'Memoria (sem IndexedDB)' : 'Armazenamento...';
  }
  const mode = el('foot-mode');
  if (mode) mode.textContent = `Modo ${state.advancedMode ? 'avancado' : 'padrao'} · ${state.settings.compactMode ? 'compacto' : 'confortavel'}`;
  const algorithm = el('foot-algorithm');
  if (algorithm) algorithm.textContent = `Algoritmo v${ALGORITHM_VERSION}`;
  const datasetFoot = el('foot-dataset');
  if (datasetFoot) {
    datasetFoot.textContent = meta?.lastContest ? `Dataset #${integer(meta.lastContest)} · ${integer(meta.totalDraws)} concursos` : 'Dataset --';
  }

  document.documentElement.dataset.theme = state.theme === 'system' ? 'system' : state.theme;
  document.documentElement.dataset.advanced = state.advancedMode ? 'on' : 'off';
  document.body.classList.toggle('is-compact', Boolean(state.settings.compactMode));
  document.body.classList.toggle('no-animations', !state.settings.animations);
}

function statusLabel(status) {
  switch (status) {
    case 'loading':
      return 'Carregando';
    case 'updating':
      return 'Atualizando';
    case 'online':
      return 'Online';
    case 'offline':
      return 'Offline';
    case 'ready':
      return 'Atualizado';
    case 'error':
      return 'Erro';
    default:
      return 'Aguardando';
  }
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

function renderDashboard() {
  const state = getState();
  const profile = getProfile(state.gameId);
  const analysis = currentAnalysis(state);
  const meta = state.dataset[state.gameId];
  const games = state.games;

  if (!analysis || !meta) {
    return `<div class="page">
      ${sectionHead('Dashboard', 'Aguardando carregamento dos dados historicos.')}
      ${emptyState('Carregando dados', 'O dataset esta sendo carregado e analisado. Use o botao Atualizar se demorar.', `<button class="btn btn-primary" data-action="refresh-data">Atualizar dados</button>`)}
    </div>`;
  }

  const lastDraw = analysis.lastDraw;
  const previous = analysis.previousDraw;
  const lastNumbers = lastDraw?.numbers ?? [];
  const repeated = lastDraw && previous ? lastNumbers.filter((n) => previous.numbers.includes(n)).length : null;
  const lastSum = lastNumbers.reduce((total, number) => total + number, 0);
  const lastEven = lastNumbers.filter((number) => number % 2 === 0).length;
  const lastPrimes = lastNumbers.filter((number) => profile.statisticalFeatures.primes.includes(number)).length;
  const frequencyItems = analysis.frequency.map((item) => ({
    label: String(item.number).padStart(2, '0'),
    value: item.count,
    hint: `Dezena ${item.number}: ${item.count} aparicoes (${percent(item.relative, 2)})`,
    tone: item.number === analysis.frequencySummary.max?.number ? 'positive' : item.number === analysis.frequencySummary.min?.number ? 'negative' : 'accent',
  }));
  const delayItems = [...analysis.delay.perNumber]
    .sort((a, b) => b.current - a.current)
    .slice(0, 12)
    .map((item) => ({ label: String(item.number).padStart(2, '0'), value: item.current, hint: `Dezena ${item.number}: ${item.current} concursos sem sair` }));

  const avgScore = local.generated.list.length
    ? local.generated.list.reduce((total, game) => total + (game.score ?? 0), 0) / local.generated.list.filter((g) => g.score !== undefined).length
    : null;

  return `<div class="page">
    ${sectionHead(
      `Dashboard · ${profile.name}`,
      `Comportamento historico observado em ${integer(analysis.totalDraws)} concursos (ate o ${integer(analysis.lastContest)}).`,
      `<button class="btn btn-ghost" data-action="refresh-data">Atualizar dados</button>
       <a class="btn btn-primary" href="#/generator" data-action="navigate" data-view="generator">Gerar jogos</a>`,
    )}

    <div class="stat-grid">
      ${statCard({
        label: 'Ultimo concurso',
        value: lastDraw ? `#${integer(lastDraw.contest)}` : '--',
        hint: lastDraw ? `${date(lastDraw.date)} · ${plural(lastDraw.numbers.length, 'dezena', 'dezenas')}` : '',
        icon: '◎',
      })}
      ${statCard({ label: 'Concursos carregados', value: integer(analysis.totalDraws), hint: `${date(analysis.firstDate)} a ${date(analysis.lastDate)}` })}
      ${statCard({ label: 'Ultima atualizacao', value: date(meta.lastUpdated), hint: meta.source === 'official' ? 'Fonte oficial' : esc(meta.source) })}
      ${statCard({ label: 'Jogos salvos', value: integer(games.length), hint: `${plural(state.presets.length, 'preset', 'presets')}` })}
      ${statCard({
        label: 'Score medio (ultima geracao)',
        value: avgScore === null || Number.isNaN(avgScore) ? '--' : decimal(avgScore, 1),
        hint: local.generated.list.length ? `${plural(local.generated.list.length, 'jogo analisado', 'jogos analisados')}` : 'Nenhuma geracao nesta sessao',
      })}
      ${statCard({
        label: 'Ultima analise',
        value: state.lastAnalysisMeta?.score !== null && state.lastAnalysisMeta?.score !== undefined ? decimal(state.lastAnalysisMeta.score, 1) : '--',
        hint: state.lastAnalysisMeta?.score !== null && state.lastAnalysisMeta?.score !== undefined ? dateTime(state.lastAnalysisMeta.generatedAt) : 'Use o analisador',
      })}
    </div>

    <div class="grid grid-2">
      <section class="card">
        ${sectionHead('Ultimo resultado', 'Dezenas sorteadas no concurso mais recente.')}
        <div class="card-body">
          ${lastDraw ? `<div class="draw-row">${balls(lastDraw.numbers, profile)}</div>
          <dl class="mini-list">
            <div><dt>Soma</dt><dd>${integer(lastSum)}</dd></div>
            <div><dt>Pares / Impares</dt><dd>${lastEven} / ${lastNumbers.length - lastEven}</dd></div>
            <div><dt>Repetidas do anterior</dt><dd>${repeated ?? '--'}</dd></div>
            <div><dt>Primos</dt><dd>${lastPrimes}</dd></div>
          </dl>` : emptyChart('Sem concursos')}
        </div>
      </section>

      <section class="card">
        ${sectionHead('Ciclo estatistico observado', 'Concursos necessarios para todas as dezenas aparecerem.')}
        <div class="card-body">
          <div class="cycle-head">
            <div>
              <span class="cycle-label">Cobertura atual</span>
              <strong class="cycle-value">${percent(analysis.cycle.coverage, 1)}</strong>
            </div>
            <div>
              <span class="cycle-label">Duracao media</span>
              <strong class="cycle-value">${decimal(analysis.cycle.meanCycleLength, 1)} concursos</strong>
            </div>
            <div>
              <span class="cycle-label">Ciclos completos</span>
              <strong class="cycle-value">${integer(analysis.cycle.cyclesCompleted)}</strong>
            </div>
          </div>
          <div class="meter meter-neutral" role="img" aria-label="Cobertura ${percent(analysis.cycle.coverage, 1)}">
            <div class="meter-fill" style="width:${Math.min(100, analysis.cycle.coverage * 100).toFixed(1)}%"></div>
          </div>
          <p class="hint">Dezenas ausentes no ciclo atual (${analysis.cycle.absent.length}):</p>
          <div class="chips">${
            analysis.cycle.absent.length
              ? analysis.cycle.absent.map((number) => `<span class="chip chip-static">${String(number).padStart(2, '0')}</span>`).join('')
              : '<span class="chip chip-static">todas as dezenas ja apareceram</span>'
          }</div>
          <p class="hint">Ciclo e agrupamento historico; nao e previsao de fechamento.</p>
        </div>
      </section>
    </div>

    <div class="grid grid-2">
      <section class="card">
        ${sectionHead('Frequencia por dezena', `Total de aparicoes nos ${integer(analysis.totalDraws)} concursos.`)}
        <div class="card-body">
          ${barChart(frequencyItems, { height: 170, ariaLabel: 'Frequencia por dezena', labelEvery: 1 })}
          <div class="split-hint">
            <span>Mais frequente: ${badge(String(analysis.frequencySummary.max?.number).padStart(2, '0'), 'positive')} (${integer(analysis.frequencySummary.max?.count)})</span>
            <span>Menos frequente: ${badge(String(analysis.frequencySummary.min?.number).padStart(2, '0'), 'negative')} (${integer(analysis.frequencySummary.min?.count)})</span>
          </div>
        </div>
      </section>

      <section class="card">
        ${sectionHead('Atraso observado', 'Concursos desde a ultima aparicao (registro historico).')}
        <div class="card-body">
          ${barChart(delayItems, { height: 170, ariaLabel: 'Atraso por dezena', barWidth: 20 })}
          <p class="hint">Atraso nao altera a probabilidade real de um sorteio futuro.</p>
        </div>
      </section>
    </div>

    <section class="card">
      ${sectionHead('Atalhos', 'Fluxo recomendado de uso.')}
      <div class="card-body row-actions">
        <a class="btn btn-ghost" href="#/analysis" data-action="navigate" data-view="analysis">Raio-X estatistico</a>
        <a class="btn btn-ghost" href="#/generator" data-action="navigate" data-view="generator">Gerar e ranquear</a>
        <a class="btn btn-ghost" href="#/backtest" data-action="navigate" data-view="backtest">Backtest</a>
        <a class="btn btn-ghost" href="#/montecarlo" data-action="navigate" data-view="montecarlo">Monte Carlo</a>
        <a class="btn btn-ghost" href="#/closures" data-action="navigate" data-view="closures">Fechamentos</a>
      </div>
    </section>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Analise                                                             */
/* ------------------------------------------------------------------ */

function renderAnalysis() {
  const state = getState();
  const profile = getProfile(state.gameId);
  const analysis = currentAnalysis(state);
  if (!analysis) return pendingView('Analise');

  const tab = local.tab.analysis;
  const tabs = [
    { id: 'overview', label: 'Raio-X' },
    { id: 'analyzer', label: 'Analisador' },
    { id: 'distribution', label: 'Distribuicao' },
  ];

  return `<div class="page">
    ${sectionHead(
      `Analise · ${profile.name}`,
      `Janela de ${integer(analysis.totalDraws)} concursos. Todos os numeros descrevem comportamento historico.`,
      `<select class="select select-sm" id="analysis-window" data-action="analysis-window" aria-label="Janela de analise">
        ${[
          [50, 'Ultimos 50'],
          [100, 'Ultimos 100'],
          [500, 'Ultimos 500'],
          [0, 'Historico completo'],
        ]
          .map(([option, label]) => `<option value="${option}"${((getSettings().historyLimit ?? 0) === option ? ' selected' : '')}>${label}</option>`)
          .join('')}
      </select>
      <button type="button" class="btn btn-ghost btn-sm" data-action="analysis-export" data-format="json">Exportar JSON</button>
      <button type="button" class="btn btn-ghost btn-sm" data-action="analysis-export" data-format="csv">CSV</button>
      <button type="button" class="btn btn-ghost btn-sm" data-action="refresh-data">Atualizar</button>`,
    )}
    <div class="tabs" role="tablist" aria-label="Secoes de analise">
      ${tabs
        .map(
          (item) => `<button type="button" role="tab" class="tab${tab === item.id ? ' is-active' : ''}" aria-selected="${tab === item.id}" data-action="set-tab" data-group="analysis" data-tab="${item.id}">${esc(item.label)}</button>`,
        )
        .join('')}
    </div>
    ${tab === 'overview' ? renderAnalysisOverview(profile, analysis) : tab === 'analyzer' ? renderAnalyzer(profile, analysis) : renderDistribution(profile, analysis)}
  </div>`;
}

function metricRow(label, stats, extra = '') {
  if (!stats) return '';
  return `<div class="metric-row">
    <span class="metric-label">${esc(label)}</span>
    <span class="metric-value">${decimal(stats.mean, 2)}</span>
    <span class="metric-band">faixa central ${decimal(stats.band.low, 1)} a ${decimal(stats.band.high, 1)}</span>
    ${extra}
  </div>`;
}

/** Agrupa uma distribuicao em no maximo `maxBars` faixas (evita barras de 1px). */
function bucketDistribution(list, maxBars = 32) {
  if (!Array.isArray(list) || list.length === 0) return [];
  if (list.length <= maxBars) return list.map((item) => ({ value: item.value, count: item.count }));
  const first = list[0].value;
  const last = list[list.length - 1].value;
  const size = Math.max(1, Math.ceil((last - first) / maxBars));
  const buckets = new Map();
  for (const item of list) {
    const bucket = Math.floor((item.value - first) / size);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + item.count);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, count]) => ({ value: first + bucket * size + Math.floor(size / 2), count }));
}

function renderAnalysisOverview(profile, analysis) {
  const sumHistogram = histogram(bucketDistribution(analysis.sums.stats.distribution), {
    formatLabel: (v) => String(v),
    height: 130,
    ariaLabel: 'Distribuicao de somas',
    barWidth: 12,
    gap: 3,
  });
  const parityItems = analysis.parity.stats.distribution.map((item) => ({
    label: String(item.value),
    value: item.count,
    hint: `${item.value} pares: ${item.count} concursos`,
  }));

  const delayed = [...analysis.delay.perNumber].sort((a, b) => b.current - a.current).slice(0, 8);

  return `<div class="stack">
    <div class="grid grid-3">
      <section class="card">
        ${sectionHead('Soma', 'Soma das dezenas por concurso.')}
        <div class="card-body">
          ${metricRow('Media', analysis.sums.stats)}
          ${metricRow('Mediana', analysis.sums.stats)}
          <p class="hint">Soma teorica de referencia: ${decimal(analysis.sums.theoretical, 1)}.</p>
          ${sumHistogram}
        </div>
      </section>
      <section class="card">
        ${sectionHead('Paridade', 'Quantidade de dezenas pares por concurso.')}
        <div class="card-body">
          ${metricRow('Pares (media)', analysis.parity.stats)}
          ${metricRow('Impares (media)', analysis.parity.oddStats)}
          ${barChart(parityItems, { height: 120, ariaLabel: 'Distribuicao de paridade' })}
        </div>
      </section>
      <section class="card">
        ${sectionHead('Estrutura', 'Primos, Fibonacci, sequencias e regiao do volante.')}
        <div class="card-body">
          ${metricRow('Primos', analysis.primes.stats)}
          ${metricRow('Fibonacci', analysis.fibonacci.stats)}
          ${metricRow('Sequencia maxima', analysis.sequences.stats)}
          ${metricRow('Moldura', analysis.frame.stats)}
          ${metricRow('Miolo', analysis.core.stats)}
        </div>
      </section>
    </div>

    <div class="grid grid-2">
      <section class="card">
        ${sectionHead('Repeticao do concurso anterior', 'Dezenas que permanecem de um concurso para o seguinte.')}
        <div class="card-body">
          ${metricRow('Repetidas', analysis.repetition.stats)}
          <p class="hint">Ultimo concurso repetiu ${analysis.repetition.lastDrawRepeated} dezenas do anterior.</p>
          <div class="chips">
            ${analysis.repetition.stats.distribution
              .filter((item) => item.count > 0)
              .map((item) => `<span class="chip chip-static">${item.value}: ${item.count}x</span>`)
              .join('')}
          </div>
        </div>
      </section>

      <section class="card">
        ${sectionHead('Atraso por dezena', 'Ordenado pelo atraso atual observado.')}
        <div class="card-body">
          ${table(
            [
              { label: 'Dezena' },
              { label: 'Atraso atual', numeric: true },
              { label: 'Media historica', numeric: true },
              { label: 'Z-score', numeric: true },
            ],
            delayed.map((item) => ({
              cells: [
                { html: `<span class="ball ball-sm">${String(item.number).padStart(2, '0')}</span>` },
                { text: integer(item.current), numeric: true },
                { text: decimal(item.mean, 2), numeric: true },
                { text: signed(item.zScore), numeric: true },
              ],
            })),
          )}
          <p class="hint">Media teorica de referencia: ${decimal(analysis.delayExpected, 2)} concursos.</p>
        </div>
      </section>
    </div>

    <section class="card">
      ${sectionHead(
        'Aderencia da distribuicao',
        'Teste chi-quadrado sobre a frequencia das dezenas.',
        `<span class="badge badge-${analysis.frequencySummary.chiSquare.pValue > 0.05 ? 'muted' : 'warning'}">p = ${decimal(analysis.frequencySummary.chiSquare.pValue, 3)}</span>`,
      )}
      <div class="card-body">
        <p class="text">
          Estatistica chi-quadrado ${decimal(analysis.frequencySummary.chiSquare.statistic, 2)} com
          ${integer(analysis.frequencySummary.chiSquare.df)} graus de liberdade. Frequencia esperada por dezena:
          ${decimal(analysis.frequencySummary.chiSquare.expected, 1)}.
        </p>
        <p class="hint">
          p alto indica que as diferencas observadas sao compativeis com variacao aleatoria. p baixo nao prova vies:
          verifique tamanho de amostra e multiplas comparacoes.
        </p>
      </div>
    </section>
  </div>`;
}

function renderAnalyzer(profile, analysis) {
  const selected = local.analyzer.numbers;
  const result = local.analyzer.result;

  return `<div class="grid grid-2">
    <section class="card">
      ${sectionHead('Volante interativo', 'Selecione as dezenas para analisar a combinacao em tempo real.')}
      <div class="card-body">
        ${volante(profile, selected, 'analyzer-toggle')}
        <div class="toolbar">
          <button type="button" class="btn btn-ghost btn-sm" data-action="analyzer-clear">Limpar</button>
          <button type="button" class="btn btn-primary btn-sm" data-action="analyzer-score">Calcular score</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="analyzer-copy">Copiar</button>
          <button type="button" class="btn btn-ghost btn-sm" data-action="analyzer-save">Salvar jogo</button>
        </div>
        <p class="hint" id="analyzer-hint">${analyzerHint(selected, profile)}</p>
      </div>
    </section>

    <section class="card">
      ${sectionHead('Metricas da combinacao', 'Calculadas localmente a partir do historico.')}
      <div class="card-body">
        <div id="analyzer-metrics">${analyzerMetrics(profile, analysis, selected)}</div>
        <div id="analyzer-result">${
          result ? renderScoreBlock(result) : emptyState('Sem score', 'Selecione as dezenas e clique em Calcular score.')
        }</div>
      </div>
    </section>
  </div>`;
}

function analyzerHint(selected, profile) {
  const size = getSettings().ticketSize;
  return `${integer(selected.length)} de ${size} dezenas selecionadas${selected.length !== size ? ' (tamanho fora do padrao)' : ''}.`;
}

function analyzerMetrics(profile, analysis, selected) {
  const live = summarizeSelection(selected, profile);
  return `<div class="metric-grid">
    <div class="metric"><span>Soma</span><strong>${integer(live.sum)}</strong><em>faixa ${decimal(analysis.sums.stats.band.low, 0)}-${decimal(analysis.sums.stats.band.high, 0)}</em></div>
    <div class="metric"><span>Pares / Impares</span><strong>${live.even} / ${live.odd}</strong><em>media ${decimal(analysis.parity.stats.mean, 1)}</em></div>
    <div class="metric"><span>Primos</span><strong>${live.primes}</strong><em>media ${decimal(analysis.primes.stats.mean, 1)}</em></div>
    <div class="metric"><span>Fibonacci</span><strong>${live.fibonacci}</strong><em>media ${decimal(analysis.fibonacci.stats.mean, 1)}</em></div>
    <div class="metric"><span>Sequencia</span><strong>${live.longestSequence}</strong><em>media ${decimal(analysis.sequences.stats.mean, 1)}</em></div>
    <div class="metric"><span>Linhas / Colunas</span><strong>${live.rowsUsed} / ${live.colsUsed}</strong><em>de ${profile.board.rows} x ${profile.board.cols}</em></div>
    <div class="metric"><span>Moldura / Miolo</span><strong>${live.frame} / ${live.core}</strong><em>media ${decimal(analysis.frame.stats.mean, 1)} / ${decimal(analysis.core.stats.mean, 1)}</em></div>
    <div class="metric"><span>Repetidas</span><strong>${live.repeated ?? '--'}</strong><em>media ${decimal(analysis.repetition.stats.mean, 1)}</em></div>
  </div>`;
}

/** Atualiza somente os paineis do analisador (sem recriar o volante). */
function refreshAnalyzerPanels() {
  const state = getState();
  const profile = getProfile(state.gameId);
  const analysis = currentAnalysis(state);
  if (!analysis) return;
  const metrics = el('analyzer-metrics');
  if (metrics) metrics.innerHTML = analyzerMetrics(profile, analysis, local.analyzer.numbers);
  const hint = el('analyzer-hint');
  if (hint) hint.textContent = analyzerHint(local.analyzer.numbers, profile);
  const resultBox = el('analyzer-result');
  if (resultBox) resultBox.innerHTML = emptyState('Sem score', 'Selecione as dezenas e clique em Calcular score.');
}

function renderScoreBlock(result) {
  const tier = scoreTier(result.score);
  return `<div class="score-block" id="score-block">
    <div class="score-head">
      ${scoreRing(result.score)}
      <div>
        <strong class="score-value">${decimal(result.score, 2)}</strong>
        <p class="score-tier">${esc(tier.label)}</p>
        <p class="hint">Aderencia aos criterios ponderados. Nao e probabilidade de premio.</p>
      </div>
    </div>
    <div class="score-components">
      ${Object.entries(result.components)
        .map(
          ([key, score]) => `<div class="score-component">
            <div class="score-component-head">
              <span>${esc({ cycle: 'Ciclo', repetition: 'Repeticao', delay: 'Atraso', structure: 'Estrutura' }[key])}</span>
              <strong>${decimal(score, 1)}</strong>
            </div>
            ${meter(score)}
            <span class="score-weight">peso ${decimal(result.weights[key], 1)}%</span>
          </div>`,
        )
        .join('')}
    </div>
    ${renderExplanations(result)}
  </div>`;
}

function renderExplanations(result) {
  return `<details class="explain" open>
    <summary>Como chegamos a este score?</summary>
    <div class="explain-body">
      <ul class="reason-list">
        ${result.reasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}
      </ul>
      ${
        result.warnings.length
          ? `<ul class="warning-list">${result.warnings.map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul>`
          : ''
      }
      <details class="explain nested">
        <summary>Detalhes tecnicos</summary>
        <pre class="code-block">${esc(JSON.stringify(result.details, null, 2))}</pre>
      </details>
    </div>
  </details>`;
}

function summarizeSelection(numbers, profile) {
  const set = [...numbers].sort((a, b) => a - b);
  const rows = new Set();
  const cols = new Set();
  let sumValue = 0;
  let even = 0;
  let primes = 0;
  let fibonacci = 0;
  let frame = 0;
  let core = 0;
  for (const number of set) {
    sumValue += number;
    if (number % 2 === 0) even += 1;
    if (profile.statisticalFeatures.primes.includes(number)) primes += 1;
    if (profile.statisticalFeatures.fibonacci.includes(number)) fibonacci += 1;
    const cell = boardCell(profile, number);
    rows.add(cell.row);
    cols.add(cell.col);
    if (cell.row === 0 || cell.col === 0 || cell.row === profile.board.rows - 1 || cell.col === profile.board.cols - 1) frame += 1;
    else core += 1;
  }
  let longest = set.length ? 1 : 0;
  let run = 1;
  for (let index = 1; index < set.length; index += 1) {
    if (set[index] === set[index - 1] + 1) {
      run += 1;
      longest = Math.max(longest, run);
    } else run = 1;
  }
  const state = getState();
  const analysis = currentAnalysis(state);
  const previous = analysis?.lastDraw;
  const repeated = previous ? set.filter((number) => previous.numbers.includes(number)).length : null;
  return {
    numbers: set,
    sum: sumValue,
    even,
    odd: set.length - even,
    primes,
    fibonacci,
    frame,
    core,
    rowsUsed: rows.size,
    colsUsed: cols.size,
    longestSequence: longest,
    repeated,
  };
}

function renderDistribution(profile, analysis) {
  const cells = analysis.spatial.cells;
  const sortedFrequency = [...analysis.frequency].sort((a, b) =>
    local.frequencySort === 'asc' ? a.count - b.count : b.count - a.count,
  );
  return `<div class="stack">
    <div class="grid grid-2">
      <section class="card">
        ${sectionHead('Mapa de calor do volante', 'Aparicoes por dezena em toda a janela analisada.')}
        <div class="card-body">${boardHeatmap(profile, cells, { cellSize: 34, ariaLabel: 'Mapa de calor das dezenas' })}</div>
      </section>
      <section class="card">
        ${sectionHead('Extremos observados', 'Cinco dezenas mais e menos frequentes.')}
        <div class="card-body">
          <h3 class="sub-title">Mais frequentes</h3>
          <ul class="rank-list">
            ${analysis.spatial.hottest
              .map(
                (item) =>
                  `<li><span class="ball ball-sm">${String(item.number).padStart(2, '0')}</span><span>${integer(item.count)} aparicoes</span><span class="muted">${percent(item.share, 2)} das dezenas sorteadas</span></li>`,
              )
              .join('')}
          </ul>
          <h3 class="sub-title">Menos frequentes</h3>
          <ul class="rank-list">
            ${analysis.spatial.coldest
              .map(
                (item) =>
                  `<li><span class="ball ball-sm">${String(item.number).padStart(2, '0')}</span><span>${integer(item.count)} aparicoes</span><span class="muted">${percent(item.share, 2)}</span></li>`,
              )
              .join('')}
          </ul>
        </div>
      </section>
    </div>

    <section class="card">
      ${sectionHead(
        'Tabela de frequencia',
        'Frequencia absoluta, relativa e desvio em relacao ao esperado.',
        `<select class="select select-sm" id="frequency-sort" data-action="frequency-sort" aria-label="Ordenar frequencia">
          <option value="asc"${local.frequencySort === 'asc' ? ' selected' : ''}>Menor frequencia</option>
          <option value="desc"${local.frequencySort === 'desc' ? ' selected' : ''}>Maior frequencia</option>
        </select>`,
      )}
      <div class="card-body">
        ${table(
          [
            { label: 'Dezena' },
            { label: 'Aparicoes', numeric: true },
            { label: 'Relativa', numeric: true },
            { label: 'Esperada', numeric: true },
            { label: 'Desvio', numeric: true },
            { label: 'Atraso atual', numeric: true },
          ],
          sortedFrequency.map((item) => {
            const delayItem = analysis.delay.perNumber.find((entry) => entry.number === item.number);
            const expected = analysis.frequencySummary.chiSquare.expected;
            const delta = item.count - expected;
            return {
              cells: [
                { html: `<span class="ball ball-sm">${String(item.number).padStart(2, '0')}</span>` },
                { text: integer(item.count), numeric: true },
                { text: percent(item.relative, 2), numeric: true },
                { text: decimal(expected, 1), numeric: true },
                { html: `<span class="${delta >= 0 ? 'text-positive' : 'text-negative'}">${signed(delta, 1)}</span>`, numeric: true },
                { text: integer(delayItem?.current ?? 0), numeric: true },
              ],
            };
          }),
        )}
      </div>
    </section>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Gerador                                                             */
/* ------------------------------------------------------------------ */

function filterDefaults(profile) {
  const size = getSettings().ticketSize;
  return {
    fixed: [],
    excluded: [],
    even: { min: 0, max: size },
    odd: { min: 0, max: size },
    sum: { min: profile.minNumber * size, max: profile.maxNumber * size },
    primes: { min: 0, max: size },
    fibonacci: { min: 0, max: size },
    repeat: { min: 0, max: size },
    maxSequence: { min: 1, max: size },
    lines: { min: 0, max: profile.board.rows },
    columns: { min: 0, max: profile.board.cols },
    frame: { min: 0, max: size },
    core: { min: 0, max: size },
    diversity: 0.55,
  };
}

function readFilters(profile, size) {
  const defaults = filterDefaults(profile);
  const readRange = (key, fallback) => {
    const low = el(`filter-${key}-min`);
    const high = el(`filter-${key}-max`);
    if (!low || !high) return fallback;
    return { min: numeric(`filter-${key}-min`, fallback.min), max: numeric(`filter-${key}-max`, fallback.max) };
  };
  const parseList = (id) =>
    value(id)
      .split(/[\s,;]+/)
      .map((item) => Number.parseInt(item, 10))
      .filter((item) => Number.isInteger(item));

  return {
    ...defaults,
    fixed: parseList('gen-fixed'),
    excluded: parseList('gen-excluded'),
    even: readRange('even', defaults.even),
    odd: readRange('odd', defaults.odd),
    sum: readRange('sum', defaults.sum),
    primes: readRange('primes', defaults.primes),
    fibonacci: readRange('fibonacci', defaults.fibonacci),
    repeat: readRange('repeat', defaults.repeat),
    maxSequence: readRange('maxSequence', defaults.maxSequence),
    lines: readRange('lines', defaults.lines),
    columns: readRange('columns', defaults.columns),
    frame: readRange('frame', defaults.frame),
    core: readRange('core', defaults.core),
    diversity: numberValue('gen-diversity', 0.55),
  };
}

function renderGenerator() {
  const state = getState();
  const profile = getProfile(state.gameId);
  const settings = getSettings();
  const analysis = currentAnalysis(state);
  if (!analysis) return pendingView('Gerador');

  const size = settings.ticketSize;
  const defaults = local.generator.filters ?? filterDefaults(profile);
  const generated = local.generated;
  const totalPages = Math.max(1, Math.ceil(generated.list.length / PAGE_SIZE));
  const page = Math.min(generated.page, totalPages - 1);
  const pageItems = generated.list.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const rows = pageItems.map((game, index) => {
    const absolute = page * PAGE_SIZE + index + 1;
    return {
      cells: [
        { html: `<input type="checkbox" class="checkbox" data-action="toggle-game" data-numbers="${game.numbers.join(',')}" ${generated.selected.has(game.numbers.join(',')) ? 'checked' : ''} aria-label="Selecionar jogo ${absolute}" />`, className: 'checkbox-cell' },
        { text: String(absolute), className: 'index-cell' },
        { html: balls(game.numbers, profile, { small: true }) },
        { html: game.score !== undefined ? `${meter(game.score)}<span class="meter-label">${decimal(game.score, 1)}</span>` : '--' },
        {
          html: `<button type="button" class="btn btn-ghost btn-xs" data-action="show-reasons" data-index="${absolute - 1}">Motivos</button>`,
        },
      ],
    };
  });

  return `<div class="page">
    ${sectionHead(
      `Gerador · ${profile.name}`,
      'Geracao heuristica com filtros estatisticos. O score indica aderencia aos criterios, nao chance de premio.',
      `<a class="btn btn-ghost" href="#/analysis" data-action="navigate" data-view="analysis">Ver analise</a>`,
    )}

    <div class="stack">
      <section class="card">
        ${sectionHead('Parametros', 'Configuracao da geracao.')}
        <div class="card-body">
          <div class="form-grid">
            <div class="field">
              <label class="label" for="gen-size">Dezenas por jogo</label>
              <select class="select" id="gen-size">
                ${Array.from({ length: profile.maxTicketSize - profile.minTicketSize + 1 }, (_, offset) => profile.minTicketSize + offset)
                  .map((option) => `<option value="${option}"${option === size ? ' selected' : ''}>${option} dezenas</option>`)
                  .join('')}
              </select>
            </div>
            <div class="field">
              <label class="label" for="gen-count">Quantidade</label>
              <select class="select" id="gen-count">
                ${[10, 50, 100, 500, 1000, 10000]
                  .map((option) => `<option value="${option}"${option === settings.generateCount ? ' selected' : ''}>${integer(option)} jogos</option>`)
                  .join('')}
              </select>
            </div>
            <div class="field">
              <label class="label" for="gen-strategy">Estrategia</label>
              <select class="select" id="gen-strategy">
                ${STRATEGIES.map((item) => `<option value="${item.id}">${esc(item.label)}</option>`).join('')}
              </select>
              <span class="hint">Heuristica de filtro, nao previsao.</span>
            </div>
            <div class="field">
              <label class="label" for="gen-seed">Seed (opcional)</label>
              <input class="input" type="text" id="gen-seed" placeholder="ex.: 12345" value="${esc(settings.seed ?? '')}" />
              <span class="hint">Mesma seed + mesmos parametros = mesmo resultado.</span>
            </div>
            <div class="field">
              <label class="label" for="gen-diversity">Diversidade <span class="label-value">${decimal(0.55, 2)}</span></label>
              <input class="range" type="range" id="gen-diversity" min="0" max="0.9" step="0.05" value="0.55" />
              <span class="hint">Maior diversidade = jogos menos parecidos entre si.</span>
            </div>
            ${state.advancedMode ? `<div class="field"><span class="label">Pesos do score</span><span class="hint">C ${settings.weights.cycle}% · R ${settings.weights.repetition}% · A ${settings.weights.delay}% · E ${settings.weights.structure}% (ajuste em Configuracoes)</span></div>` : ''}
          </div>

          <div class="preset-bar">
            <select class="select select-sm" id="gen-preset" aria-label="Presets salvos">
              <option value="">Presets salvos (${getState().presets.length})</option>
              ${getState()
                .presets.map((preset) => `<option value="${esc(preset.id)}">${esc(truncate(preset.name, 40))}</option>`)
                .join('')}
            </select>
            <button type="button" class="btn btn-ghost btn-sm" data-action="preset-apply">Aplicar</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="preset-save">Salvar filtros</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="preset-delete">Excluir</button>
          </div>

          <details class="filters"${state.advancedMode ? ' open' : ''}>
            <summary>Filtros avancados</summary>
            <div class="filters-body">
              <div class="field">
                <label class="label" for="gen-fixed">Dezenas fixas</label>
                <input class="input" type="text" id="gen-fixed" placeholder="ex.: 1 5 10" />
              </div>
              <div class="field">
                <label class="label" for="gen-excluded">Dezenas excluidas</label>
                <input class="input" type="text" id="gen-excluded" placeholder="ex.: 2 4 6" />
              </div>
              <div class="filter-grid">
                ${rangeField('filter', 'even', 'Pares', 0, size, defaults.even)}
                ${rangeField('filter', 'odd', 'Impares', 0, size, defaults.odd)}
                ${rangeField('filter', 'sum', 'Soma', profile.minNumber * size, profile.maxNumber * size, defaults.sum)}
                ${rangeField('filter', 'primes', 'Primos', 0, size, defaults.primes)}
                ${rangeField('filter', 'fibonacci', 'Fibonacci', 0, size, defaults.fibonacci)}
                ${rangeField('filter', 'repeat', 'Repeticao', 0, size, defaults.repeat)}
                ${rangeField('filter', 'maxSequence', 'Sequencia maxima', 1, size, defaults.maxSequence)}
                ${rangeField('filter', 'lines', 'Linhas usadas', 0, profile.board.rows, defaults.lines)}
                ${rangeField('filter', 'columns', 'Colunas usadas', 0, profile.board.cols, defaults.columns)}
                ${rangeField('filter', 'frame', 'Moldura', 0, size, defaults.frame)}
                ${rangeField('filter', 'core', 'Miolo', 0, size, defaults.core)}
              </div>
            </div>
          </details>

          <div class="row-actions">
            <button type="button" class="btn btn-primary" data-action="generator-run">Gerar jogos</button>
            <button type="button" class="btn btn-ghost" data-action="generator-rank">Gerar e ranquear</button>
            ${state.busy ? `<button type="button" class="btn btn-danger" data-action="cancel-op">Cancelar</button>` : ''}
          </div>
          ${progressBlock(state.progress)}
        </div>
      </section>

      <section class="card">
        ${sectionHead(
          'Resultado',
          generated.meta ? `${plural(generated.list.length, 'jogo', 'jogos')} · estrategia ${esc(generated.meta.strategy ?? 'personalizada')}${generated.meta.seed ? ` · seed ${esc(generated.meta.seed)}` : ''}` : 'Nenhuma geracao nesta sessao.',
          `<div class="row-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="generator-export" data-format="json">JSON</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="generator-export" data-format="csv">CSV</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="generator-export" data-format="txt">TXT</button>
          </div>`,
        )}
        <div class="card-body">
          ${
            generated.list.length === 0
              ? emptyState('Sem jogos', 'Configure os parametros e clique em Gerar jogos.')
              : `${table(
                  [
                    { label: '' },
                    { label: '#' },
                    { label: 'Dezenas' },
                    { label: 'Score' },
                    { label: '' },
                  ],
                  rows,
                )}
                <div class="pagination">
                  <button type="button" class="btn btn-ghost btn-sm" data-action="generator-page" data-page="${page - 1}" ${page === 0 ? 'disabled' : ''}>Anterior</button>
                  <span class="pagination-info">Pagina ${page + 1} de ${totalPages}</span>
                  <button type="button" class="btn btn-ghost btn-sm" data-action="generator-page" data-page="${page + 1}" ${page >= totalPages - 1 ? 'disabled' : ''}>Proxima</button>
                </div>
                <div class="row-actions">
                  <button type="button" class="btn btn-primary btn-sm" data-action="generator-save">Salvar selecionados (${generated.selected.size})</button>
                  <button type="button" class="btn btn-ghost btn-sm" data-action="generator-save-all">Salvar todos</button>
                </div>`
          }
          <div id="reasons-panel" class="reasons-panel"></div>
        </div>
      </section>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Backtest                                                            */
/* ------------------------------------------------------------------ */

function sourceOptions(selected) {
  return `<option value="generated"${selected === 'generated' ? ' selected' : ''}>Ultima geracao</option>
    <option value="saved"${selected === 'saved' ? ' selected' : ''}>Meus jogos</option>
    <option value="analyzer"${selected === 'analyzer' ? ' selected' : ''}>Combinacao do analisador</option>`;
}

function gamesForSource(source) {
  const state = getState();
  if (source === 'saved') return state.games.map((game) => ({ numbers: game.numbers, score: game.score }));
  if (source === 'analyzer') {
    return local.analyzer.numbers.length ? [{ numbers: [...local.analyzer.numbers].sort((a, b) => a - b) }] : [];
  }
  return local.generated.list.map((game) => ({ numbers: game.numbers, score: game.score }));
}

function renderBacktest() {
  const state = getState();
  const profile = getProfile(state.gameId);
  const analysis = currentAnalysis(state);
  if (!analysis) return pendingView('Backtest');
  const settings = getSettings();
  const games = gamesForSource(local.backtest.source);
  const result = local.backtest.result;

  return `<div class="page">
    ${sectionHead(
      'Backtest',
      'Avaliacao historica dos jogos contra os concursos passados. Nao representa desempenho futuro.',
    )}
    <div class="grid grid-2">
      <section class="card">
        ${sectionHead('Configuracao', 'Fonte dos jogos, periodo e custo.')}
        <div class="card-body">
          <div class="form-grid">
            <div class="field">
              <label class="label" for="bt-source">Fonte dos jogos</label>
              <select class="select" id="bt-source" data-action="bt-source">${sourceOptions(local.backtest.source)}</select>
              <span class="hint">${plural(games.length, 'jogo disponivel', 'jogos disponiveis')}</span>
            </div>
            <div class="field">
              <label class="label" for="bt-window">Periodo</label>
              <select class="select" id="bt-window">
                ${[50, 100, 500, 0]
                  .map((option) => `<option value="${option}"${option === local.backtest.window ? ' selected' : ''}>${option === 0 ? 'Historico completo' : `Ultimos ${option} concursos`}</option>`)
                  .join('')}
              </select>
            </div>
            <div class="field">
              <label class="label" for="bt-cost">Custo por jogo (R$)</label>
              <input class="input" type="number" id="bt-cost" min="0" step="0.01" value="${settings.costPerTicket ?? 0}" />
              <span class="hint">Usado apenas para ROI. Zero desativa o calculo financeiro.</span>
            </div>
          </div>
          <div class="row-actions">
            <button type="button" class="btn btn-primary" data-action="backtest-run" ${games.length === 0 ? 'disabled' : ''}>Executar backtest</button>
            <button type="button" class="btn btn-ghost" data-action="backtest-export" ${result ? '' : 'disabled'}>Exportar CSV</button>
          </div>
          ${progressBlock(state.busy ? state.progress : null)}
          ${games.length === 0 ? `<p class="hint">Gere jogos ou salve jogos para executar o backtest.</p>` : ''}
        </div>
      </section>

      <section class="card">
        ${sectionHead('Resultado', result ? `${plural(result.totalGames, 'jogo', 'jogos')} em ${plural(result.totalDraws, 'concurso', 'concursos')}` : 'Nenhuma execucao ainda.')}
        <div class="card-body">
          ${
            !result
              ? emptyState('Sem resultado', 'Escolha a fonte e execute o backtest.')
              : `<div class="stat-grid stat-grid-2">
                  ${statCard({ label: 'Media de acertos', value: decimal(result.averageHits, 2), hint: 'por jogo e concurso' })}
                  ${statCard({ label: 'Hit rate', value: percent(result.hitRate, 2), hint: 'faixas premiadas' })}
                  ${statCard({ label: 'Custo total', value: result.totalCost === null ? 'Nao informado' : `${money(result.totalCost)}`, hint: 'custo por jogo x jogos' })}
                  ${statCard({
                    label: 'ROI historico',
                    value: result.roi === null ? 'Nao calculado' : percentValue(result.roi, 2),
                    hint: result.grossReturn === null ? 'premiacao indisponivel' : `retorno ${money(result.grossReturn)}`,
                    tone: result.roi === null ? '' : result.roi >= 0 ? 'positive' : 'negative',
                  })}
                </div>
                ${histogram(
                  result.distribution.map((item) => ({ value: item.hits, count: item.count })),
                  { formatLabel: (v) => `${v} acertos`, height: 140, ariaLabel: 'Distribuicao de acertos' },
                )}
                ${table(
                  [{ label: 'Faixa' }, { label: 'Ocorrencias', numeric: true }, { label: 'Valor total', numeric: true }, { label: 'Premio medio', numeric: true }],
                  result.tierStats.map((tier) => ({
                    cells: [
                      { html: badge(tier.label, tier.count > 0 ? 'positive' : 'muted') },
                      { text: integer(tier.count), numeric: true },
                      { text: tier.knownPrizes ? money(tier.amount) : '--', numeric: true },
                      { text: tier.averagePrize ? money(tier.averagePrize) : '--', numeric: true },
                    ],
                  })),
                )}
                <ul class="note-list">${result.notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>`
          }
        </div>
      </section>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Monte Carlo                                                         */
/* ------------------------------------------------------------------ */

function renderMonteCarlo() {
  const state = getState();
  const settings = getSettings();
  const analysis = currentAnalysis(state);
  if (!analysis) return pendingView('Monte Carlo');
  const games = gamesForSource(local.monteCarlo.source);
  const result = local.monteCarlo.result;

  return `<div class="page">
    ${sectionHead(
      'Monte Carlo',
      'Compara a estrategia com jogos aleatorios no mesmo periodo. Diferencas pequenas sao esperadas por variacao.',
    )}
    <div class="grid grid-2">
      <section class="card">
        ${sectionHead('Configuracao', 'Simulacao executada no Worker com progresso e cancelamento.')}
        <div class="card-body">
          <div class="form-grid">
            <div class="field">
              <label class="label" for="mc-source">Fonte dos jogos</label>
              <select class="select" id="mc-source" data-action="mc-source">${sourceOptions(local.monteCarlo.source)}</select>
              <span class="hint">${plural(games.length, 'jogo disponivel', 'jogos disponiveis')}</span>
            </div>
            <div class="field">
              <label class="label" for="mc-simulations">Simulacoes</label>
              <select class="select" id="mc-simulations">
                ${[500, 1000, 5000, 10000, 50000]
                  .map((option) => `<option value="${option}"${option === settings.monteCarloSimulations ? ' selected' : ''}>${integer(option)}</option>`)
                  .join('')}
              </select>
            </div>
            <div class="field">
              <label class="label" for="mc-window">Concursos por simulacao</label>
              <select class="select" id="mc-window">
                ${[20, 50, 100, 200]
                  .map((option) => `<option value="${option}"${option === local.monteCarlo.window ? ' selected' : ''}>Ultimos ${option}</option>`)
                  .join('')}
              </select>
            </div>
          </div>
          <div class="row-actions">
            <button type="button" class="btn btn-primary" data-action="mc-run" ${games.length === 0 ? 'disabled' : ''}>Executar simulacao</button>
            ${state.busy ? `<button type="button" class="btn btn-danger" data-action="cancel-op">Cancelar</button>` : ''}
          </div>
          ${progressBlock(state.busy ? state.progress : null)}
        </div>
      </section>

      <section class="card">
        ${sectionHead('Comparativo', result ? `${integer(result.simulations)} simulacoes concluidas` : 'Nenhuma simulacao executada.')}
        <div class="card-body">
          ${
            !result
              ? emptyState('Sem resultado', 'Execute a simulacao para comparar estrategia e aleatoriedade.')
              : `<div class="compare-grid">
                  <div class="compare-card">
                    <span class="compare-label">Estrategia</span>
                    <strong>${decimal(result.strategy.meanHits, 3)}</strong>
                    <span class="compare-hint">media de acertos</span>
                  </div>
                  <div class="compare-card">
                    <span class="compare-label">Aleatorio (media)</span>
                    <strong>${decimal(result.random.mean, 3)}</strong>
                    <span class="compare-hint">p50 ${decimal(result.random.percentiles.p50, 3)}</span>
                  </div>
                  <div class="compare-card compare-diff">
                    <span class="compare-label">Diferenca</span>
                    <strong class="${result.difference.absolute >= 0 ? 'text-positive' : 'text-negative'}">${signed(result.difference.absolute, 3)}</strong>
                    <span class="compare-hint">percentil ${decimal(result.difference.percentile, 1)}</span>
                  </div>
                </div>
                ${histogram(
                  result.histogram.map((item) => ({ value: item.value, count: item.count })),
                  { formatLabel: (v) => decimal(v, 2), height: 150, ariaLabel: 'Distribuicao de simulacoes aleatorias' },
                )}
                ${table(
                  [{ label: 'Percentil' }, { label: 'Media de acertos', numeric: true }],
                  [
                    ['p5', result.random.percentiles.p5],
                    ['p25', result.random.percentiles.p25],
                    ['p50', result.random.percentiles.p50],
                    ['p75', result.random.percentiles.p75],
                    ['p95', result.random.percentiles.p95],
                    ['p99', result.random.percentiles.p99],
                  ].map(([label, value]) => ({ cells: [{ text: label }, { text: decimal(value, 3), numeric: true }] })),
                )}
                <ul class="note-list">${result.notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>`
          }
        </div>
      </section>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Fechamentos                                                         */
/* ------------------------------------------------------------------ */

function renderClosures() {
  const state = getState();
  const profile = getProfile(state.gameId);
  const analysis = currentAnalysis(state);
  if (!analysis) return pendingView('Fechamentos');
  const base = local.closure.base;
  const result = local.closure.result;

  return `<div class="page">
    ${sectionHead(
      'Fechamentos',
      'Distribui dezenas de um conjunto base em varios jogos. Mostra cobertura de pares, sem promessa de premiacao.',
    )}
    <div class="grid grid-2">
      <section class="card">
        ${sectionHead('Conjunto base', 'Selecione as dezenas que serao distribuidas.')}
        <div class="card-body">
          ${volante(profile, base, 'closure-toggle')}
          <div class="form-grid">
            <div class="field">
              <label class="label" for="cl-size">Tamanho do jogo</label>
              <select class="select" id="cl-size">
                ${Array.from({ length: profile.maxTicketSize - profile.minTicketSize + 1 }, (_, offset) => profile.minTicketSize + offset)
                  .map((option) => `<option value="${option}"${option === profile.ticketSize ? ' selected' : ''}>${option} dezenas</option>`)
                  .join('')}
              </select>
            </div>
            <div class="field">
              <label class="label" for="cl-max">Maximo de jogos</label>
              <select class="select" id="cl-max">
                ${[10, 20, 50, 100, 500]
                  .map((option) => `<option value="${option}">${option} jogos</option>`)
                  .join('')}
              </select>
            </div>
          </div>
          <div class="row-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="closure-clear">Limpar</button>
            <button type="button" class="btn btn-primary" id="closure-run" data-action="closure-run" ${base.length < profile.ticketSize ? 'disabled' : ''}>Gerar fechamento</button>
            <button type="button" class="btn btn-ghost" data-action="closure-save" ${result ? '' : 'disabled'}>Salvar jogos</button>
          </div>
          <p class="hint" id="closure-hint">${plural(base.length, 'dezena selecionada', 'dezenas selecionadas')}. Minimo: ${profile.ticketSize}.</p>
        </div>
      </section>

      <section class="card">
        ${sectionHead('Resultado', result ? `${plural(result.generated, 'jogo gerado', 'jogos gerados')}` : 'Nenhum fechamento gerado.')}
        <div class="card-body">
          ${
            !result
              ? emptyState('Sem fechamento', 'Selecione as dezenas base e gere o fechamento.')
              : `<div class="stat-grid stat-grid-2">
                  ${statCard({ label: 'Combinacoes possiveis', value: compactNumber(result.totalPossible), hint: 'C(base, tamanho)' })}
                  ${statCard({ label: 'Cobertura de pares', value: percent(result.coverage.ratio, 1), hint: `${integer(result.coverage.pairsCovered)} de ${integer(result.coverage.pairsTotal)} pares` })}
                  ${statCard({ label: 'Dezenas utilizadas', value: `${result.coverage.baseNumbersUsed}/${result.coverage.baseNumbersTotal}`, hint: 'do conjunto base' })}
                  ${statCard({ label: 'Jogos gerados', value: integer(result.generated), hint: result.truncated ? 'limitado pelo maximo' : 'completo' })}
                </div>
                ${table(
                  [{ label: '#' }, { label: 'Dezenas' }, { label: 'Acertos no ultimo concurso', numeric: true }],
                  result.games.slice(0, 50).map((numbers, index) => ({
                    cells: [
                      { text: String(index + 1) },
                      { html: balls(numbers, profile, { small: true }) },
                      { text: integer(numbers.filter((number) => analysis.lastDraw?.numbers.includes(number)).length), numeric: true },
                    ],
                  })),
                )}
                <p class="hint">${esc(result.note)}</p>`
          }
        </div>
      </section>
    </div>
  </div>`;
}

function refreshClosurePanel() {
  const state = getState();
  const profile = getProfile(state.gameId);
  const hint = el('closure-hint');
  if (hint) hint.textContent = `${plural(local.closure.base.length, 'dezena selecionada', 'dezenas selecionadas')}. Minimo: ${profile.ticketSize}.`;
  const run = el('closure-run');
  if (run) run.disabled = local.closure.base.length < profile.ticketSize;
}

/* ------------------------------------------------------------------ */
/* Meus jogos                                                          */
/* ------------------------------------------------------------------ */

function hitsOf(game, analysis) {
  if (!analysis?.lastDraw) return null;
  return game.numbers.filter((number) => analysis.lastDraw.numbers.includes(number)).length;
}

function isWinner(hits, profile) {
  if (hits === null) return false;
  return profile.prizeRules.tiers.some((tier) => tier.hits === hits);
}

function renderGames() {
  const state = getState();
  const profile = getProfile(state.gameId);
  const analysis = currentAnalysis(state);
  const all = state.games;
  const filtered = all.filter((game) => {
    if (local.gamesFilter === 'all') return true;
    const hits = hitsOf(game, analysis);
    if (local.gamesFilter === 'winners') return isWinner(hits, profile);
    if (local.gamesFilter === 'losers') return hits !== null && !isWinner(hits, profile);
    if (local.gamesFilter === 'last') return true;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(local.gamesPage, totalPages - 1);
  const items = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const winners = all.filter((game) => isWinner(hitsOf(game, analysis), profile)).length;

  return `<div class="page">
    ${sectionHead(
      `Meus jogos · ${profile.name}`,
      `${plural(all.length, 'jogo salvo', 'jogos salvos')} · ${plural(winners, 'premiado no ultimo concurso', 'premiados no ultimo concurso')}.`,
      `<div class="row-actions">
        <label class="btn btn-ghost btn-sm" for="import-file">Importar</label>
        <input class="visually-hidden" type="file" id="import-file" accept=".json,.csv,.txt" />
        <button type="button" class="btn btn-ghost btn-sm" data-action="games-add">Adicionar manual</button>
        <button type="button" class="btn btn-ghost btn-sm" data-action="games-export">Exportar JSON</button>
      </div>`,
    )}

    <section class="card">
      ${sectionHead(
        'Jogos salvos',
        analysis?.lastDraw
          ? `Conferencia automatica contra o concurso ${integer(analysis.lastDraw.contest)} (${date(analysis.lastDraw.date)}).`
          : 'Dados do ultimo concurso indisponiveis para conferencia.',
        `<select class="select select-sm" id="games-filter" data-action="games-filter" aria-label="Filtrar jogos">
          <option value="all"${local.gamesFilter === 'all' ? ' selected' : ''}>Todos</option>
          <option value="winners"${local.gamesFilter === 'winners' ? ' selected' : ''}>Premiados</option>
          <option value="losers"${local.gamesFilter === 'losers' ? ' selected' : ''}>Nao premiados</option>
        </select>`,
      )}
      <div class="card-body">
        ${
          items.length === 0
            ? emptyState('Nenhum jogo', 'Gere jogos, importe um arquivo ou adicione manualmente.')
            : table(
                [
                  { label: '' },
                  { label: 'Dezenas' },
                  { label: 'Score', numeric: true },
                  { label: 'Origem' },
                  { label: 'Salvo em' },
                  { label: `Acertos (${analysis?.lastDraw ? `#${analysis.lastDraw.contest}` : '--'})`, numeric: true },
                  { label: '' },
                ],
                items.map((game) => {
                  const hits = hitsOf(game, analysis);
                  const winner = isWinner(hits, profile);
                  return {
                    cells: [
                      {
                        html: `<input type="checkbox" class="checkbox" data-action="toggle-saved" data-id="${esc(game.id)}" ${local.gamesSelected.has(game.id) ? 'checked' : ''} aria-label="Selecionar jogo" />`,
                        className: 'checkbox-cell',
                      },
                      { html: balls(game.numbers, profile, { small: true }) },
                      { text: game.score === null || game.score === undefined ? '--' : decimal(game.score, 1), numeric: true },
                      { html: badge(game.source ?? 'app', 'muted') },
                      { text: dateTime(game.createdAt) },
                      { html: hits === null ? '--' : badge(String(hits), winner ? 'positive' : 'muted'), numeric: true },
                      {
                        html: `<div class="table-actions">
                          <button type="button" class="btn btn-ghost btn-xs" data-action="game-copy" data-id="${esc(game.id)}">Copiar</button>
                          <button type="button" class="btn btn-ghost btn-xs" data-action="game-check" data-id="${esc(game.id)}">Conferir</button>
                          <button type="button" class="btn btn-danger btn-xs" data-action="game-delete" data-id="${esc(game.id)}">Excluir</button>
                        </div>`,
                      },
                    ],
                  };
                }),
              )
        }
        <div class="pagination">
          <button type="button" class="btn btn-ghost btn-sm" data-action="games-page" data-page="${page - 1}" ${page === 0 ? 'disabled' : ''}>Anterior</button>
          <span class="pagination-info">Pagina ${page + 1} de ${totalPages}</span>
          <button type="button" class="btn btn-ghost btn-sm" data-action="games-page" data-page="${page + 1}" ${page >= totalPages - 1 ? 'disabled' : ''}>Proxima</button>
        </div>
        <div class="row-actions">
          <button type="button" class="btn btn-danger btn-sm" data-action="games-delete-selected" ${local.gamesSelected.size ? '' : 'disabled'}>Excluir selecionados (${local.gamesSelected.size})</button>
        </div>
      </div>
    </section>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Configuracoes                                                       */
/* ------------------------------------------------------------------ */

function weightField(key, label, weights) {
  return `<div class="weight-field">
    <label class="label" for="w-${key}">${esc(label)}</label>
    <div class="weight-input">
      <input class="input input-compact" type="number" id="w-${key}" min="0" max="100" step="1" value="${weights[key]}" data-action="weights-input" />
      <span class="weight-unit" aria-hidden="true">%</span>
    </div>
  </div>`;
}

function renderSettings() {
  const state = getState();
  const settings = getSettings();
  const profile = getProfile(state.gameId);
  const meta = state.dataset[state.gameId];
  const total = Number(settings.weights.cycle) + Number(settings.weights.repetition) + Number(settings.weights.delay) + Number(settings.weights.structure);

  return `<div class="page">
    ${sectionHead('Configuracoes', 'Preferencias persistidas localmente. Nenhum dado sai do dispositivo.')}
    <div class="grid grid-2">
      <section class="card">
        ${sectionHead('Geral', 'Preferencias de interface e padroes de geracao.')}
        <div class="card-body">
          <div class="form-grid">
            <div class="field">
              <label class="label" for="set-game">Modalidade padrao</label>
              <select class="select" id="set-game">
                ${GAME_IDS.map((id) => `<option value="${id}"${id === settings.gameId ? ' selected' : ''}>${esc(getProfile(id).name)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="label" for="set-theme">Tema</label>
              <select class="select" id="set-theme">
                ${['light', 'dark', 'system'].map((theme) => `<option value="${theme}"${theme === settings.theme ? ' selected' : ''}>${theme === 'light' ? 'Claro' : theme === 'dark' ? 'Escuro' : 'Sistema'}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="label" for="set-ticket">Dezenas por jogo (padrao)</label>
              <select class="select" id="set-ticket">
                ${Array.from({ length: profile.maxTicketSize - profile.minTicketSize + 1 }, (_, offset) => profile.minTicketSize + offset)
                  .map((option) => `<option value="${option}"${option === settings.ticketSize ? ' selected' : ''}>${option}</option>`)
                  .join('')}
              </select>
            </div>
            <div class="field">
              <label class="label" for="set-count">Jogos por geracao</label>
              <select class="select" id="set-count">
                ${[10, 50, 100, 500, 1000].map((option) => `<option value="${option}"${option === settings.generateCount ? ' selected' : ''}>${integer(option)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="label" for="set-window">Periodo historico padrao</label>
              <select class="select" id="set-window">
                ${[50, 100, 500, 0].map((option) => `<option value="${option}"${option === settings.historyLimit ? ' selected' : ''}>${option === 0 ? 'Completo' : `Ultimos ${option}`}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="label" for="set-cost">Custo por jogo (R$)</label>
              <input class="input" type="number" id="set-cost" min="0" step="0.01" value="${settings.costPerTicket ?? 0}" />
            </div>
          </div>
          <div class="switch-grid">
            <label class="switch"><input type="checkbox" id="set-advanced" ${settings.advancedMode ? 'checked' : ''} /><span>Modo avancado (metricas tecnicas)</span></label>
            <label class="switch"><input type="checkbox" id="set-compact" ${settings.compactMode ? 'checked' : ''} /><span>Modo compacto</span></label>
            <label class="switch"><input type="checkbox" id="set-animations" ${settings.animations ? 'checked' : ''} /><span>Animacoes</span></label>
          </div>
        </div>
      </section>

      <section class="card">
        ${sectionHead('Pesos do score', 'Os pesos indicam aderencia aos criterios. Se nao somarem 100, serao normalizados.')}
        <div class="card-body">
          <div class="weight-grid">
            ${weightField('cycle', 'Ciclo', settings.weights)}
            ${weightField('repetition', 'Repeticao', settings.weights)}
            ${weightField('delay', 'Atraso', settings.weights)}
            ${weightField('structure', 'Estrutura', settings.weights)}
          </div>
          <p class="hint" id="weights-preview">Soma atual: <strong>${decimal(total, 0)}%</strong>${Math.abs(total - 100) > 0.001 ? ' — sera normalizada automaticamente.' : ' — total valido.'}</p>
          <div class="row-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="settings-reset-weights">Restaurar padrao</button>
          </div>

          <h3 class="sub-title">Monte Carlo</h3>
          <div class="form-grid">
            <div class="field">
              <label class="label" for="set-mc-sims">Simulacoes padrao</label>
              <select class="select" id="set-mc-sims">
                ${[500, 1000, 5000, 10000, 50000].map((option) => `<option value="${option}"${option === settings.monteCarloSimulations ? ' selected' : ''}>${integer(option)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="label" for="set-mc-window">Concursos por simulacao</label>
              <select class="select" id="set-mc-window">
                ${[20, 50, 100, 200].map((option) => `<option value="${option}"${option === settings.monteCarloWindow ? ' selected' : ''}>${option}</option>`).join('')}
              </select>
            </div>
          </div>
        </div>
      </section>
    </div>

    <div class="grid grid-2">
      <section class="card">
        ${sectionHead('Dados', 'Dataset, cache e persistencia local.')}
        <div class="card-body">
          <dl class="mini-list">
            <div><dt>Dataset</dt><dd>${esc(profile.datasetFile)}</dd></div>
            <div><dt>Ultimo concurso</dt><dd>${meta?.lastContest ? `#${integer(meta.lastContest)} (${date(meta.lastDate)})` : '--'}</dd></div>
            <div><dt>Concursos</dt><dd>${integer(meta?.totalDraws ?? 0)}</dd></div>
            <div><dt>Hash</dt><dd class="mono">${meta?.hash ? esc(`${meta.hash.slice(0, 16)}...`) : '--'}</dd></div>
            <div><dt>Armazenamento</dt><dd>${state.storageMode === 'indexeddb' ? 'IndexedDB' : 'Memoria (temporario)'}</dd></div>
            <div><dt>Worker</dt><dd>${state.workerReady ? 'Ativo' : 'Indisponivel (fallback)'}</dd></div>
          </dl>
          <div class="row-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-action="refresh-data">Atualizar dados</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="settings-clear-cache">Limpar cache local</button>
            <button type="button" class="btn btn-ghost btn-sm" data-action="settings-benchmark">Executar benchmark</button>
          </div>
          <p class="hint">Limpar o cache remove a copia offline do dataset; os jogos salvos sao preservados.</p>
        </div>
      </section>

      <section class="card">
        ${sectionHead('Sobre', 'Informacoes de versao e limites.')}
        <div class="card-body">
          <dl class="mini-list">
            <div><dt>Aplicacao</dt><dd>${esc(APP.name)}</dd></div>
            <div><dt>Versao</dt><dd>${esc(APP.version)}</dd></div>
            <div><dt>Algoritmo</dt><dd>${esc(ALGORITHM_VERSION)}</dd></div>
            <div><dt>Armazenamento</dt><dd>${state.storageMode}</dd></div>
          </dl>
          <p class="text">${esc(DISCLAIMER)}</p>
          <p class="hint">
            Dados historicos publicos. O aplicativo nao preve resultados, nao garante premiacao e nao coleta dados pessoais.
            Todo o processamento ocorre no seu dispositivo.
          </p>
        </div>
      </section>
    </div>

    <div class="sticky-actions">
      <button type="button" class="btn btn-primary" data-action="settings-save">Salvar configuracoes</button>
      <button type="button" class="btn btn-ghost" data-action="settings-reset">Restaurar padroes</button>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Utilitarios de view                                                 */
/* ------------------------------------------------------------------ */

function money(amount) {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '--';
  return Number(amount).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function pendingView(title) {
  return `<div class="page">
    ${sectionHead(title, 'Aguardando analise dos dados.')}
    ${emptyState('Carregando', 'Os dados historicos ainda nao foram analisados.', `<button class="btn btn-primary" data-action="refresh-data">Atualizar dados</button>`)}
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Modais                                                              */
/* ------------------------------------------------------------------ */

export function closeModal() {
  const root = el('modal-root');
  if (root) root.replaceChildren();
  if (local.modalRelease) {
    local.modalRelease();
    local.modalRelease = null;
  }
}

/**
 * @param {{title:string, body:string, actions?:Array<{label:string,tone?:string,onClick?:Function,close?:boolean}>, onOpen?:Function}} config
 */
export function openModal(config) {
  const root = el('modal-root');
  if (!root) return;
  closeModal();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.dataset.action = 'modal-backdrop';

  const dialog = document.createElement('div');
  dialog.className = 'modal';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'modal-title');

  const header = document.createElement('header');
  header.className = 'modal-header';
  const title = document.createElement('h2');
  title.id = 'modal-title';
  title.className = 'modal-title';
  title.textContent = config.title;
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'icon-btn';
  closeButton.setAttribute('aria-label', 'Fechar');
  closeButton.textContent = '×';
  closeButton.addEventListener('click', closeModal);
  header.append(title, closeButton);

  const body = document.createElement('div');
  body.className = 'modal-body';
  body.innerHTML = config.body ?? '';

  const footer = document.createElement('footer');
  footer.className = 'modal-footer';
  for (const action of config.actions ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn ${action.tone === 'primary' ? 'btn-primary' : action.tone === 'danger' ? 'btn-danger' : 'btn-ghost'}`;
    button.textContent = action.label;
    button.addEventListener('click', async () => {
      try {
        await action.onClick?.();
      } catch (error) {
        notifyError(error?.message ?? 'Falha na acao');
      } finally {
        if (action.close !== false) closeModal();
      }
    });
    footer.appendChild(button);
  }

  dialog.append(header, body, footer);
  backdrop.appendChild(dialog);
  root.appendChild(backdrop);

  local.modalRelease = trapFocus(dialog, {
    onEscape: closeModal,
  });
  config.onOpen?.(body);
}

/* ------------------------------------------------------------------ */
/* Substituicoes de estado vindas da aplicacao                         */
/* ------------------------------------------------------------------ */

export function setGeneratedGames(games, meta = {}) {
  local.generated.list = Array.isArray(games) ? games : [];
  local.generated.meta = meta;
  local.generated.selected = new Set();
  local.generated.page = 0;
  render();
}

export function setBacktestResult(result) {
  local.backtest.result = result;
  render();
}

export function setMonteCarloResult(result) {
  local.monteCarlo.result = result;
  render();
}

export function setClosureResult(result) {
  local.closure.result = result;
  render();
}

export function setAnalyzerResult(result) {
  local.analyzer.result = result;
  render();
}

/** Atualiza apenas a barra de progresso (evita re-render completo). */
export function updateProgressBar(progress) {
  const node = el('op-progress');
  if (!node) return;
  const percentDone = Math.max(0, Math.min(100, Number(progress?.percent) || 0));
  const fill = node.querySelector('.progress-fill');
  if (fill) fill.style.width = `${percentDone}%`;
  const metas = node.querySelectorAll('.progress-meta span');
  if (metas[1] && progress?.processed && progress?.total) metas[1].textContent = `${integer(progress.processed)} / ${integer(progress.total)}`;
  if (metas[2]) metas[2].textContent = `${decimal(percentDone, 0)}%`;
  node.dataset.percent = String(percentDone);
}

/* ------------------------------------------------------------------ */
/* Acoes                                                               */
/* ------------------------------------------------------------------ */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    notifySuccess('Copiado para a area de transferencia.');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      notifySuccess('Copiado para a area de transferencia.');
    } catch {
      notifyError('Nao foi possivel copiar.');
    } finally {
      area.remove();
    }
  }
}

function currentProfile() {
  return getProfile(getState().gameId);
}

function generatorParams() {
  const profile = currentProfile();
  const size = numeric('gen-size', profile.ticketSize);
  return {
    size,
    count: numeric('gen-count', 10),
    strategy: value('gen-strategy', 'balanceada'),
    seed: value('gen-seed', ''),
    filters: readFilters(profile, size),
    weights: getSettings().weights,
    diversity: numberValue('gen-diversity', 0.55),
  };
}

function showReasons(index) {
  const panel = el('reasons-panel');
  const game = local.generated.list[index];
  if (!panel || !game) return;
  if (!game.reasons) {
    panel.innerHTML = emptyState('Sem explicacao', 'Gere com a opcao "Gerar e ranquear" para obter os motivos por jogo.');
    return;
  }
  panel.innerHTML = `<div class="reasons-card">
    <div class="reasons-head">${balls(game.numbers, currentProfile(), { small: true })}${scoreRing(game.score, { size: 64, stroke: 7 })}</div>
    <ul class="reason-list">${game.reasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul>
    ${game.warnings?.length ? `<ul class="warning-list">${game.warnings.map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul>` : ''}
  </div>`;
  const top = panel.getBoundingClientRect().top + window.scrollY - 90;
  window.scrollTo({ top: Math.max(0, top), left: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

function gamesFromSelection() {
  const selected = local.generated.list.filter((game) => local.generated.selected.has(game.numbers.join(',')));
  return selected.length > 0 ? selected : local.generated.list;
}

async function handleAction(action, target) {
  const handlers = local.handlers;
  if (!handlers) return;
  const state = getState();
  const profile = currentProfile();

  switch (action) {
    case 'navigate': {
      const view = target.dataset.view;
      if (!view) return;
      if (location.hash !== `#/${view}`) location.hash = `#/${view}`;
      else handlers.onNavigate(view);
      document.getElementById('sidebar')?.classList.remove('is-open');
      document.getElementById('menu-toggle')?.setAttribute('aria-expanded', 'false');
      return;
    }
    case 'select-game':
      await handlers.onSelectGame(target.dataset.game);
      return;
    case 'refresh-data':
    case 'data-refresh':
      await handlers.onRefresh();
      return;
    case 'toggle-theme':
      handlers.onToggleTheme();
      return;
    case 'set-tab':
      local.tab[target.dataset.group] = target.dataset.tab;
      render();
      return;
    case 'generator-run':
      local.generated.kind = 'generate';
      await handlers.onGenerate(generatorParams());
      return;
    case 'generator-rank':
      local.generated.kind = 'rank';
      await handlers.onRank({ ...generatorParams(), candidateCount: Math.min(20000, Math.max(400, numeric('gen-count', 10) * 40)) });
      return;
    case 'cancel-op':
      await handlers.onCancel();
      return;
    case 'generator-page':
      local.generated.page = Math.max(0, Number.parseInt(target.dataset.page, 10) || 0);
      render();
      return;
    case 'toggle-game': {
      const key = target.dataset.numbers;
      if (!key) return;
      if (target.checked) local.generated.selected.add(key);
      else local.generated.selected.delete(key);
      resetSelectionLabel();
      return;
    }
    case 'toggle-saved': {
      const id = target.dataset.id;
      if (!id) return;
      if (target.checked) local.gamesSelected.add(id);
      else local.gamesSelected.delete(id);
      resetSelectionLabel(action);
      return;
    }
    case 'generator-save': {
      const games = gamesFromSelection().map((game) => ({ numbers: game.numbers, score: game.score ?? null, source: 'generator' }));
      await handlers.onSaveGames(games);
      return;
    }
    case 'generator-save-all': {
      const games = local.generated.list.map((game) => ({ numbers: game.numbers, score: game.score ?? null, source: 'generator' }));
      await handlers.onSaveGames(games);
      return;
    }
    case 'generator-export':
      await handlers.onExportGames(target.dataset.format ?? 'json', local.generated.list);
      return;
    case 'preset-apply': {
      const preset = getState().presets.find((item) => item.id === value('gen-preset', ''));
      if (!preset) {
        notifyWarning('Selecione um preset salvo.');
        return;
      }
      local.generator.filters = { ...filterDefaults(profile), ...preset.filters };
      render();
      notifySuccess(`Preset "${preset.name}" aplicado aos filtros.`);
      return;
    }
    case 'preset-save':
      openModal({
        title: 'Salvar preset de filtros',
        body: `<label class="label" for="preset-name">Nome do preset</label>
          <input class="input" type="text" id="preset-name" maxlength="40" placeholder="ex.: Conservador 15 dezenas" />`,
        actions: [
          { label: 'Cancelar' },
          {
            label: 'Salvar',
            tone: 'primary',
            onClick: async () => {
              const name = sanitizeText(value('preset-name', ''), 40);
              if (!name) {
                notifyWarning('Informe um nome.');
                return;
              }
              await handlers.onSavePreset(name, readFilters(profile, getSettings().ticketSize));
            },
          },
        ],
        onOpen: () => document.getElementById('preset-name')?.focus(),
      });
      return;
    case 'preset-delete': {
      const presetId = value('gen-preset', '');
      if (!presetId) {
        notifyWarning('Selecione um preset salvo.');
        return;
      }
      await handlers.onDeletePreset(presetId);
      return;
    }
    case 'analysis-window':
      await handlers.onSetAnalysisWindow(numeric('analysis-window', 0));
      return;
    case 'analysis-export':
      await handlers.onExportAnalysis(target.dataset.format ?? 'json');
      return;    case 'show-reasons':
      showReasons(Number.parseInt(target.dataset.index, 10) || 0);
      return;
    case 'analyzer-toggle': {
      const number = Number.parseInt(target.dataset.number, 10);
      const set = new Set(local.analyzer.numbers);
      if (set.has(number)) {
        set.delete(number);
      } else {
        if (set.size >= profile.maxTicketSize) {
          notifyWarning(`Maximo de ${profile.maxTicketSize} dezenas por jogo.`);
          return;
        }
        set.add(number);
      }
      local.analyzer.numbers = [...set].sort((a, b) => a - b);
      local.analyzer.result = null;
      target.classList.toggle('is-selected', set.has(number));
      target.setAttribute('aria-pressed', String(set.has(number)));
      refreshAnalyzerPanels();
      return;
    }
    case 'analyzer-clear':
      local.analyzer.numbers = [];
      local.analyzer.result = null;
      for (const cell of document.querySelectorAll('.volante-cell.is-selected')) {
        cell.classList.remove('is-selected');
        cell.setAttribute('aria-pressed', 'false');
      }
      refreshAnalyzerPanels();
      return;
    case 'analyzer-score':
      if (local.analyzer.numbers.length !== state.settings.ticketSize) {
        notifyWarning(`Selecione exatamente ${state.settings.ticketSize} dezenas para calcular o score.`);
        return;
      }
      await handlers.onScoreCombination(local.analyzer.numbers);
      return;
    case 'analyzer-copy':
      await copyText(local.analyzer.numbers.map((number) => String(number).padStart(2, '0')).join(' '));
      return;
    case 'analyzer-save':
      if (local.analyzer.numbers.length === 0) {
        notifyWarning('Selecione as dezenas antes de salvar.');
        return;
      }
      await handlers.onSaveGames([
        { numbers: [...local.analyzer.numbers].sort((a, b) => a - b), score: local.analyzer.result?.score ?? null, source: 'analyzer' },
      ]);
      return;
    case 'bt-source':
      local.backtest.source = value('bt-source', 'generated');
      render();
      return;
    case 'backtest-run': {
      const games = gamesForSource(local.backtest.source);
      local.backtest.window = numeric('bt-window', 100);
      local.backtest.cost = numberValue('bt-cost', 0);
      await handlers.onBacktest({ games, window: local.backtest.window, cost: local.backtest.cost });
      return;
    }
    case 'backtest-export':
      await handlers.onExportBacktest(local.backtest.result, target.dataset.format ?? 'csv');
      return;
    case 'mc-source':
      local.monteCarlo.source = value('mc-source', 'generated');
      render();
      return;
    case 'mc-run': {
      const games = gamesForSource(local.monteCarlo.source);
      local.monteCarlo.simulations = numeric('mc-simulations', 1000);
      local.monteCarlo.window = numeric('mc-window', 50);
      await handlers.onMonteCarlo({
        games,
        simulations: local.monteCarlo.simulations,
        window: local.monteCarlo.window,
        cost: getSettings().costPerTicket,
      });
      return;
    }
    case 'closure-toggle': {
      const number = Number.parseInt(target.dataset.number, 10);
      const set = new Set(local.closure.base);
      if (set.has(number)) {
        set.delete(number);
      } else {
        if (set.size >= 25) {
          notifyWarning('Maximo de 25 dezenas no conjunto base.');
          return;
        }
        set.add(number);
      }
      local.closure.base = [...set].sort((a, b) => a - b);
      target.classList.toggle('is-selected', set.has(number));
      target.setAttribute('aria-pressed', String(set.has(number)));
      refreshClosurePanel();
      return;
    }
    case 'closure-clear':
      local.closure.base = [];
      local.closure.result = null;
      for (const cell of document.querySelectorAll('.volante-cell.is-selected')) {
        cell.classList.remove('is-selected');
        cell.setAttribute('aria-pressed', 'false');
      }
      refreshClosurePanel();
      return;
    case 'closure-run':
      await handlers.onClosure({
        base: local.closure.base,
        size: numeric('cl-size', profile.ticketSize),
        maxGames: numeric('cl-max', 20),
        seed: '',
      });
      return;
    case 'closure-save':
      if (local.closure.result) {
        await handlers.onSaveGames(
          local.closure.result.games.map((numbers) => ({ numbers, score: null, source: 'closure' })),
        );
      }
      return;
    case 'games-filter':
      local.gamesFilter = value('games-filter', 'all');
      local.gamesPage = 0;
      render();
      return;
    case 'games-page':
      local.gamesPage = Math.max(0, Number.parseInt(target.dataset.page, 10) || 0);
      render();
      return;
    case 'game-delete': {
      const game = state.games.find((item) => item.id === target.dataset.id);
      if (!game) return;
      openModal({
        title: 'Excluir jogo',
        body: `<p>Confirma a exclusao do jogo <strong>${esc(game.numbers.join(' '))}</strong>?</p>`,
        actions: [
          { label: 'Cancelar', tone: 'ghost' },
          { label: 'Excluir', tone: 'danger', onClick: () => handlers.onDeleteGame(game.id) },
        ],
      });
      return;
    }
    case 'game-copy': {
      const game = state.games.find((item) => item.id === target.dataset.id);
      if (game) await copyText(game.numbers.map((number) => String(number).padStart(2, '0')).join(' '));
      return;
    }
    case 'game-check': {
      const game = state.games.find((item) => item.id === target.dataset.id);
      const analysis = currentAnalysis(state);
      if (!game || !analysis?.lastDraw) {
        notifyWarning('Sem concurso disponivel para conferencia.');
        return;
      }
      const hits = hitsOf(game, analysis);
      const tier = profile.prizeRules.tiers.find((item) => item.hits === hits);
      openModal({
        title: `Conferencia · concurso ${analysis.lastDraw.contest}`,
        body: `<div class="stack">
          <p>Jogo: ${balls(game.numbers, profile, { small: true })}</p>
          <p>Resultado: ${balls(analysis.lastDraw.numbers, profile, { small: true })}</p>
          <p><strong>${hits} acerto(s)</strong> ${tier ? `— faixa ${esc(tier.label)}` : '— fora das faixas premiadas'}.</p>
        </div>`,
        actions: [{ label: 'Fechar' }],
      });
      return;
    }
    case 'games-delete-selected': {
      const ids = [...local.gamesSelected];
      if (ids.length === 0) return;
      openModal({
        title: 'Excluir jogos',
        body: `<p>Confirma a exclusao de ${plural(ids.length, 'jogo', 'jogos')}?</p>`,
        actions: [
          { label: 'Cancelar' },
          {
            label: 'Excluir',
            tone: 'danger',
            onClick: async () => {
              await handlers.onDeleteGames(ids);
              local.gamesSelected.clear();
            },
          },
        ],
      });
      return;
    }
    case 'games-export':
      await handlers.onExportGames('json', state.games);
      return;
    case 'games-add':
      openModal({
        title: 'Adicionar jogos',
        body: `<p class="hint">Informe uma combinacao por linha (15 dezenas para Lotofacil, 6 para Mega-Sena).</p>
          <textarea class="textarea" id="manual-games" rows="8" placeholder="01 02 03 04 05 06 07 08 09 10 11 12 13 14 15"></textarea>`,
        actions: [
          { label: 'Cancelar' },
          {
            label: 'Adicionar',
            tone: 'primary',
            onClick: async () => {
              const text = value('manual-games', '');
              if (!text.trim()) {
                notifyWarning('Nenhuma dezena informada.');
                return;
              }
              await handlers.onImportGames({ text, filename: 'manual.txt' });
            },
          },
        ],
      });
      return;
    case 'settings-save':
      await handlers.onSaveSettings(readSettingsForm());
      return;
    case 'settings-reset':
      await handlers.onSaveSettings({ ...DEFAULT_SETTINGS });
      return;
    case 'settings-reset-weights':
      await handlers.onSaveSettings({ weights: { ...DEFAULT_SETTINGS.weights } });
      return;
    case 'settings-clear-cache':
      await handlers.onClearCache();
      return;
    case 'settings-benchmark': {
      const result = await handlers.onBenchmark({ size: state.settings.ticketSize, count: 1000 });
      if (result) openBenchmarkModal(result);
      return;
    }
    case 'modal-close':
      closeModal();
      return;
    default:
      return;
  }
}

function resetSelectionLabel(action = 'toggle-game') {
  const button = document.querySelector(
    action === 'toggle-game' ? '[data-action="generator-save"]' : '[data-action="games-delete-selected"]',
  );
  if (!button) return;
  if (action === 'toggle-game') {
    button.textContent = `Salvar selecionados (${local.generated.selected.size})`;
  } else {
    button.textContent = `Excluir selecionados (${local.gamesSelected.size})`;
  }
}

function readSettingsForm() {
  const current = getSettings();
  const weights = {
    cycle: Math.max(0, numeric('w-cycle', current.weights.cycle)),
    repetition: Math.max(0, numeric('w-repetition', current.weights.repetition)),
    delay: Math.max(0, numeric('w-delay', current.weights.delay)),
    structure: Math.max(0, numeric('w-structure', current.weights.structure)),
  };
  return {
    gameId: value('set-game', current.gameId),
    theme: value('set-theme', current.theme),
    ticketSize: numeric('set-ticket', current.ticketSize),
    generateCount: numeric('set-count', current.generateCount),
    historyLimit: numeric('set-window', current.historyLimit),
    costPerTicket: numberValue('set-cost', current.costPerTicket),
    advancedMode: checked('set-advanced'),
    compactMode: checked('set-compact'),
    animations: checked('set-animations'),
    monteCarloSimulations: numeric('set-mc-sims', current.monteCarloSimulations),
    monteCarloWindow: numeric('set-mc-window', current.monteCarloWindow),
    weights,
  };
}

function openBenchmarkModal(result) {
  openModal({
    title: 'Benchmark',
    body: `<dl class="mini-list">
      <div><dt>Jogos gerados</dt><dd>${integer(result.generated)}</dd></div>
      <div><dt>Tempo de geracao</dt><dd>${duration(result.generationTime)}</dd></div>
      <div><dt>Tempo de score</dt><dd>${duration(result.scoringTime)}</dd></div>
      <div><dt>Total</dt><dd>${duration(result.total)}</dd></div>
      <div><dt>Por jogo</dt><dd>${decimal(result.perGameMs, 3)} ms</dd></div>
      <div><dt>Worker</dt><dd>${getState().workerReady ? 'sim' : 'fallback na main thread'}</dd></div>
    </dl>
    <p class="hint">Tempos variam conforme hardware, navegador e carga da maquina.</p>`,
    actions: [{ label: 'Fechar' }],
  });
}

/* ------------------------------------------------------------------ */
/* Eventos                                                             */
/* ------------------------------------------------------------------ */

function onClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'weights-input') return;
  if (target.tagName === 'A' && target.getAttribute('href')?.startsWith('#')) event.preventDefault();
  if (target.disabled) return;

  if (action === 'modal-backdrop') {
    if (event.target === target) closeModal();
    return;
  }
  if (action === 'menu-toggle') {
    const sidebar = el('sidebar');
    const isOpen = sidebar?.classList.toggle('is-open');
    target.setAttribute('aria-expanded', String(Boolean(isOpen)));
    return;
  }
  handleAction(action, target).catch((error) => {
    notifyError(error?.message ?? 'Falha ao executar acao');
    if (typeof console !== 'undefined') console.error(error);
  });
}

function onChange(event) {
  const target = event.target;
  if (target.id === 'import-file') {
    const file = target.files?.[0];
    if (!file) return;
    if (file.size > LIMITS.maxImportBytes) {
      notifyError('Arquivo maior que o limite permitido (8 MB).');
      target.value = '';
      return;
    }
    file
      .text()
      .then((text) => local.handlers.onImportGames({ text, filename: file.name }))
      .catch((error) => notifyError(error?.message ?? 'Falha ao ler arquivo'))
      .finally(() => {
        target.value = '';
      });
    return;
  }

  const actionTarget = target.closest('[data-action]');
  if (!actionTarget) return;
  const action = actionTarget.dataset.action;
  if (['bt-source', 'mc-source', 'games-filter', 'analysis-window'].includes(action)) {
    handleAction(action, actionTarget).catch((error) => notifyError(error?.message ?? 'Falha'));
  }
  if (action === 'frequency-sort') {
    local.frequencySort = target.value;
    render();
  }
}

function onInput(event) {
  const target = event.target;
  if (target.dataset.action === 'weights-input') {
    const preview = el('weights-preview');
    if (!preview) return;
    const total = ['cycle', 'repetition', 'delay', 'structure'].reduce((sumValue, key) => sumValue + (Number(el(`w-${key}`)?.value) || 0), 0);
    preview.innerHTML = `Soma atual: <strong>${decimal(total, 0)}%</strong>${Math.abs(total - 100) > 0.001 ? ' — sera normalizada automaticamente.' : ' — total valido.'}`;
  }
  if (target.id === 'gen-diversity') {
    const label = target.closest('.field')?.querySelector('.label-value');
    if (label) label.textContent = decimal(Number(target.value) || 0, 2);
  }
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

export function render() {
  const state = getState();
  renderChrome();
  const container = el('view');
  if (!container) return;

  let html = '';
  try {
    switch (state.view) {
      case 'analysis':
        html = renderAnalysis();
        break;
      case 'generator':
        html = renderGenerator();
        break;
      case 'backtest':
        html = renderBacktest();
        break;
      case 'montecarlo':
        html = renderMonteCarlo();
        break;
      case 'closures':
        html = renderClosures();
        break;
      case 'games':
        html = renderGames();
        break;
      case 'settings':
        html = renderSettings();
        break;
      case 'dashboard':
      default:
        html = renderDashboard();
        break;
    }
  } catch (error) {
    html = `<div class="page">${emptyState('Erro ao renderizar', error?.message ?? 'Falha inesperada', `<button class="btn btn-primary" data-action="refresh-data">Recarregar dados</button>`)}</div>`;
    if (typeof console !== 'undefined') console.error(error);
  }

  container.innerHTML = html;
  syncChipStates(container);
}

export function initUI(handlers) {
  local.handlers = handlers;
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') closeModal();
  });
  render();
}

export { progressToast, announcePolite };
