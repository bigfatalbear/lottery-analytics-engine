/**
 * Acessibilidade: foco, teclado, modais e preferencias de movimento.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusableElements(container) {
  if (!container) return [];
  return [...container.querySelectorAll(FOCUSABLE)].filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

/**
 * Prende o foco dentro de um container (modal/drawer).
 * @returns {() => void} libera o trap
 */
export function trapFocus(container, { initial = null, onEscape = null } = {}) {
  if (!container) return () => {};
  const previous = document.activeElement;

  const handleKeydown = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onEscape?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const elements = focusableElements(container);
    if (elements.length === 0) {
      event.preventDefault();
      return;
    }
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', handleKeydown);
  const target = initial ?? focusableElements(container)[0] ?? container;
  if (!target.hasAttribute('tabindex') && target === container) target.setAttribute('tabindex', '-1');
  target.focus();

  return () => {
    container.removeEventListener('keydown', handleKeydown);
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  };
}

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Anuncia mensagem em regiao aria-live (fallback quando o toast nao e adequado). */
export function announcePolite(message) {
  if (typeof document === 'undefined') return;
  let region = document.getElementById('sr-announcer');
  if (!region) {
    region = document.createElement('div');
    region.id = 'sr-announcer';
    region.className = 'sr-only';
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    document.body.appendChild(region);
  }
  region.textContent = '';
  window.setTimeout(() => {
    region.textContent = String(message ?? '');
  }, 50);
}

/** Atalhos globais de teclado. */
export function registerShortcuts(map) {
  const handler = (event) => {
    const target = event.target;
    const isField =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (isField) return;
    const key = event.key;
    const action = map[key];
    if (!action) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    action(event);
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}

/** Marca o elemento pai do radio/checkbox como selecionado (uso em chips). */
export function syncChipStates(container) {
  if (!container) return;
  for (const input of container.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
    const label = input.closest('label');
    if (label) label.classList.toggle('is-selected', input.checked);
  }
}
