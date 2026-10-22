import { $, $$, h, reducedMotion, isTouch, session } from './util.js';
import { createRoom, roomHref } from './api.js';

export const arrowIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M9 4l4 4-4 4"/></svg>';
export const checkIcon = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>';
export const closeIcon = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg>';
export const lockIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/></svg>';
export const markSvg = '<svg class="logo-mark" viewBox="0 0 64 64" aria-hidden="true"><rect class="tile" width="64" height="64" rx="18"/><rect class="bar" x="13" y="29" width="22" height="6" rx="3"/><rect class="caret" x="40" y="15" width="7" height="34" rx="3.5"/></svg>';

// ------------------------------------------------------------------ theme

const THEME_KEY = 'midsentence:theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#0d0d0c' : '#f2efe7';
}

/** Theme switch that wipes the new theme in as a circle from the button. */
export function initThemeToggle(button) {
  if (!button) return;
  const label = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    button.setAttribute('aria-label', `Switch to ${next} theme`);
  };
  label();
  button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    const swap = () => {
      applyTheme(next);
      label();
    };
    if (!document.startViewTransition || reducedMotion()) return swap();
    const r = button.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const root = document.documentElement.style;
    root.setProperty('--vt-x', `${x}px`);
    root.setProperty('--vt-y', `${y}px`);
    root.setProperty('--vt-r', `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`);
    document.startViewTransition(swap);
  });
  // Follow the OS setting until the person picks a theme themselves.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    let saved = null;
    try {
      saved = localStorage.getItem(THEME_KEY);
    } catch {}
    if (!saved) {
      applyTheme(e.matches ? 'dark' : 'light');
      label();
    }
  });
}

// ------------------------------------------------------------------ toasts

let toastRoot;
export function toast(message, { icon = '✓', duration = 3200 } = {}) {
  toastRoot ||= document.body.appendChild(h('div.toasts', { role: 'status', 'aria-live': 'polite' }));
  const el = h(
    'div.toast',
    icon && h('span.toast-icon', { 'aria-hidden': 'true' }, icon),
    h('span.toast-text', message),
    h('span.toast-progress', { style: { animationDuration: `${duration}ms` } })
  );
  const dismiss = () => {
    if (el.classList.contains('is-leaving')) return;
    el.classList.add('is-leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };
  el.addEventListener('click', dismiss);
  toastRoot.append(el);
  while (toastRoot.children.length > 3) toastRoot.firstElementChild.remove();
  setTimeout(dismiss, duration);
  return dismiss;
}

// ------------------------------------------------------------------- modal

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])';

export function createModal(root, { onOpen, onClose } = {}) {
  let lastFocus = null;
  const card = $('.modal-card', root);

  function open(trigger) {
    lastFocus = document.activeElement;
    // Grow the dialog out of whatever was clicked.
    const r = trigger?.getBoundingClientRect?.();
    if (r?.width && !reducedMotion()) {
      card.style.setProperty('--from-x', `${(r.left + r.width / 2 - innerWidth / 2) * 0.35}px`);
      card.style.setProperty('--from-y', `${(r.top + r.height / 2 - innerHeight / 2) * 0.35}px`);
    } else {
      card.style.setProperty('--from-x', '0px');
      card.style.setProperty('--from-y', '24px');
    }
    root.hidden = false;
    document.documentElement.classList.add('is-locked');
    requestAnimationFrame(() => root.classList.add('is-open'));
    onOpen?.();
  }

  function close() {
    if (root.hidden || root.classList.contains('is-closing')) return;
    root.classList.remove('is-open');
    root.classList.add('is-closing');
    const done = () => {
      root.hidden = true;
      root.classList.remove('is-closing');
      document.documentElement.classList.remove('is-locked');
      onClose?.();
    };
    reducedMotion() ? done() : setTimeout(done, 220);
    lastFocus?.focus?.({ preventScroll: true });
  }

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
    if (e.key === 'Tab') {
      const items = $$(FOCUSABLE, card).filter((el) => el.offsetParent !== null);
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  return { open, close };
}

// ------------------------------------------------------- create-room dialog

const IDEAS = ['Study session', 'Friday standup', 'Watch party', 'Brainstorm', 'Book club', 'Rubber duck'];

let createDialog;
export function openCreateRoom(trigger, preset = {}) {
  createDialog ||= buildCreateDialog();
  createDialog.open(trigger, preset);
}

/** Create a room and walk into it — shared by the dialog and inline forms. */
export async function createAndEnter({ name, topic = '', isPublic = true, id }) {
  const [room] = await Promise.all([createRoom({ id, name, topic, isPublic }), new Promise((r) => setTimeout(r, 450))]);
  session.set('midsentence:autojoin', room.id);
  return room;
}

function buildCreateDialog() {
  const switchBtn = h('button.switch', { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-labelledby': 'create-private-label' }, h('span.switch-thumb'));
  const nameInput = h('input', { name: 'name', maxlength: 48, placeholder: 'Late night ideas', autocomplete: 'off', spellcheck: 'false' });
  const topicInput = h('input', { name: 'topic', maxlength: 90, placeholder: 'What’s this room about?', autocomplete: 'off' });
  const count = h('span.field-count', '0/48');
  const error = h('p.form-error', { role: 'alert' });
  const privateNote = h('span', 'Hidden from the homepage — only people with the link can get in.');
  const submit = h(
    'button.btn.btn-primary.btn-lg.btn-block',
    { type: 'submit' },
    h('span.btn-label', 'Create room'),
    h('span.btn-dot', { 'aria-hidden': 'true', html: arrowIcon }),
    h('span.btn-spinner', { 'aria-hidden': 'true' }),
    h('span.btn-check', { 'aria-hidden': 'true', html: checkIcon })
  );

  const chips = h(
    'div.chips',
    IDEAS.map((idea) =>
      h('button.chip', {
        type: 'button',
        onclick: () => {
          nameInput.value = idea;
          nameInput.dispatchEvent(new Event('input'));
          nameInput.focus();
        },
      }, idea)
    )
  );

  const form = h(
    'form.modal-card',
    { novalidate: true },
    h('button.icon-btn.modal-x', { type: 'button', 'data-close': true, 'aria-label': 'Close', html: closeIcon }),
    h('p.modal-eyebrow', h('span', { html: markSvg }), 'New room'),
    h('h2.modal-title', { id: 'create-title' }, 'Start a room'),
    h('p.modal-sub', 'Name it, share the link, start typing.'),
    h('label.field', h('span.field-label', 'Room name'), h('span.field-wrap', nameInput, count)),
    chips,
    h('label.field', h('span.field-label', 'Topic ', h('em', 'optional')), h('span.field-wrap', topicInput)),
    h('div.toggle-row', h('div', h('strong', { id: 'create-private-label' }, 'Link-only room'), privateNote), switchBtn),
    error,
    submit,
    h('p.modal-foot', 'No account needed · ', h('kbd', 'Esc'), ' to close')
  );

  const root = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'create-title', hidden: true }, h('div.modal-backdrop', { 'data-close': true }), form);
  document.body.append(root);
  $('.modal-eyebrow .logo-mark', root).style.cssText = 'width:20px;height:20px';

  let busy = false;
  const modal = createModal(root, {
    onOpen: () => setTimeout(() => nameInput.focus(), 80),
    onClose: () => reset(),
  });

  function reset() {
    busy = false;
    form.reset();
    submit.classList.remove('is-loading', 'is-done');
    submit.disabled = false;
    error.textContent = '';
    count.textContent = '0/48';
    switchBtn.setAttribute('aria-checked', 'false');
  }

  nameInput.addEventListener('input', () => {
    count.textContent = `${nameInput.value.length}/48`;
    count.classList.toggle('is-near', nameInput.value.length > 40);
    error.textContent = '';
  });
  switchBtn.addEventListener('click', () => {
    switchBtn.setAttribute('aria-checked', String(switchBtn.getAttribute('aria-checked') !== 'true'));
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const name = nameInput.value.trim();
    if (!name) {
      error.textContent = 'Give your room a name first.';
      form.classList.remove('has-error');
      void form.offsetWidth;
      form.classList.add('has-error');
      nameInput.focus();
      return;
    }
    busy = true;
    submit.disabled = true;
    submit.classList.add('is-loading');
    try {
      const room = await createAndEnter({
        name,
        topic: topicInput.value.trim(),
        isPublic: switchBtn.getAttribute('aria-checked') !== 'true',
        id: form.dataset.id || undefined,
      });
      submit.classList.remove('is-loading');
      submit.classList.add('is-done');
      setTimeout(() => (location.href = roomHref(room.id, { secret: room.isPublic === false })), 380);
    } catch (err) {
      busy = false;
      submit.disabled = false;
      submit.classList.remove('is-loading');
      error.textContent = err.message || 'Couldn’t create the room. Try again?';
    }
  });

  return {
    open(trigger, preset) {
      reset();
      form.dataset.id = preset.id || '';
      if (preset.name) {
        nameInput.value = preset.name;
        count.textContent = `${preset.name.length}/48`;
      }
      modal.open(trigger);
    },
  };
}

// ------------------------------------------------------------ interactions

/** Cards that light up under the cursor. */
export function initSpotlight(root = document) {
  if (isTouch()) return;
  root.addEventListener('pointermove', (e) => {
    const el = e.target.closest?.('[data-spotlight]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
  });
}

/** Buttons that lean towards the cursor, just a little. */
export function initMagnetic(root = document) {
  if (isTouch() || reducedMotion()) return;
  for (const el of $$('[data-magnetic]', root)) {
    const strength = Number(el.dataset.magnetic) || 0.2;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--tx', `${(e.clientX - r.left - r.width / 2) * strength}px`);
      el.style.setProperty('--ty', `${(e.clientY - r.top - r.height / 2) * strength}px`);
    });
    el.addEventListener('pointerleave', () => {
      el.style.setProperty('--tx', '0px');
      el.style.setProperty('--ty', '0px');
    });
  }
}

/** Fade sections in as they scroll into view. */
export function initReveal(root = document) {
  const items = $$('[data-reveal]', root);
  for (const group of $$('[data-stagger]', root)) {
    [...group.children].forEach((child, i) => child.style.setProperty('--i', i % 3));
  }
  if (!('IntersectionObserver' in window) || reducedMotion()) {
    items.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.06 }
  );
  items.forEach((el) => io.observe(el));
}
