/**
 * Notificacoes (toasts) acessiveis via aria-live.
 * Nao usa inline JavaScript nem innerHTML: todo texto entra por textContent.
 */

const state = {
  container: null,
  liveRegion: null,
  counter: 0,
  timers: new Map(),
};

const ICONS = {
  success: '✓',
  info: 'i',
  warning: '!',
  error: '×',
  progress: '…',
};

function ensureContainer() {
  if (typeof document === 'undefined') return null;
  if (state.container?.isConnected) return state.container;

  let region = document.getElementById('toast-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toast-region';
    region.className = 'toast-region';
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'false');
    document.body.appendChild(region);
  }
  state.container = region;

  if (!state.liveRegion) {
    const live = document.createElement('div');
    live.id = 'sr-live';
    live.className = 'sr-only';
    live.setAttribute('aria-live', 'assertive');
    live.setAttribute('aria-atomic', 'true');
    document.body.appendChild(live);
    state.liveRegion = live;
  }
  return region;
}

export function announce(message) {
  ensureContainer();
  if (!state.liveRegion) return;
  state.liveRegion.textContent = '';
  window.setTimeout(() => {
    if (state.liveRegion) state.liveRegion.textContent = message;
  }, 60);
}

/**
 * @param {'success'|'info'|'warning'|'error'} type
 * @param {string} message
 * @param {{title?:string, timeout?:number, action?:{label:string, onClick:Function}}} [options]
 */
export function notify(type, message, options = {}) {
  const region = ensureContainer();
  if (!region) return null;

  state.counter += 1;
  const id = `toast-${state.counter}`;
  const tone = ICONS[type] ? type : 'info';
  const timeout = options.timeout ?? (tone === 'error' ? 9000 : 4800);

  const toast = document.createElement('div');
  toast.className = `toast toast-${tone}`;
  toast.id = id;
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = ICONS[tone];

  const body = document.createElement('div');
  body.className = 'toast-body';

  if (options.title) {
    const title = document.createElement('strong');
    title.className = 'toast-title';
    title.textContent = options.title;
    body.appendChild(title);
  }

  const text = document.createElement('p');
  text.className = 'toast-text';
  text.textContent = String(message ?? '');
  body.appendChild(text);

  if (options.action) {
    const actionButton = document.createElement('button');
    actionButton.type = 'button';
    actionButton.className = 'btn btn-ghost btn-xs';
    actionButton.textContent = options.action.label;
    actionButton.addEventListener('click', () => {
      try {
        options.action.onClick?.();
      } finally {
        dismiss(id);
      }
    });
    body.appendChild(actionButton);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Fechar notificacao');
  close.textContent = '×';
  close.addEventListener('click', () => dismiss(id));

  toast.append(icon, body, close);
  region.appendChild(toast);

  if (timeout > 0) {
    const timer = window.setTimeout(() => dismiss(id), timeout);
    state.timers.set(id, timer);
  }
  announce(String(message ?? ''));
  return id;
}

export function dismiss(id) {
  const timer = state.timers.get(id);
  if (timer) {
    window.clearTimeout(timer);
    state.timers.delete(id);
  }
  const element = document.getElementById(id);
  if (!element) return;
  element.classList.add('toast-leaving');
  window.setTimeout(() => element.remove(), 200);
}

export const notifySuccess = (message, options) => notify('success', message, options);
export const notifyInfo = (message, options) => notify('info', message, options);
export const notifyWarning = (message, options) => notify('warning', message, options);
export const notifyError = (message, options) => notify('error', message, options);

/**
 * Toast persistente com progresso e acao de cancelamento.
 * @returns {{update:(percent:number, detail?:string)=>void, close:()=>void}}
 */
export function progressToast(title, onCancel) {
  const region = ensureContainer();
  const id = `toast-progress-${++state.counter}`;
  if (!region) return { update() {}, close() {} };

  const toast = document.createElement('div');
  toast.className = 'toast toast-progress';
  toast.id = id;
  toast.setAttribute('role', 'status');

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = ICONS.progress;

  const body = document.createElement('div');
  body.className = 'toast-body';

  const heading = document.createElement('strong');
  heading.className = 'toast-title';
  heading.textContent = title;

  const bar = document.createElement('div');
  bar.className = 'progress';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = '0%';
  bar.appendChild(fill);

  const detail = document.createElement('p');
  detail.className = 'toast-text';
  detail.textContent = 'Iniciando...';

  body.append(heading, bar, detail);

  if (onCancel) {
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'btn btn-ghost btn-xs';
    cancelButton.textContent = 'Cancelar';
    cancelButton.addEventListener('click', () => {
      onCancel();
      detail.textContent = 'Cancelando...';
    });
    body.appendChild(cancelButton);
  }

  toast.append(icon, body);
  region.appendChild(toast);

  return {
    update(percentValue, detailText) {
      const clamped = Math.max(0, Math.min(100, Number(percentValue) || 0));
      fill.style.width = `${clamped}%`;
      if (detailText) detail.textContent = detailText;
    },
    close() {
      toast.remove();
    },
  };
}
