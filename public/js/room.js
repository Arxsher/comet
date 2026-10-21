import { $, $$, h, avatar, clock, copyText, diffChars, reducedMotion, isTouch, session, store, plural } from './lib/util.js';
import { getMode, getRoom, createRoom, shareUrl, isValidRoomId } from './lib/api.js';
import { COLORS, getProfile, saveProfile, randomName, tabId, uid } from './lib/identity.js';
import { connectRoom } from './lib/transport.js';
import { toast, initRipples, openCreateRoom } from './lib/ui.js';

const REACTIONS = ['👍', '❤️', '😂', '🔥', '👀', '✨'];
const GROUP_WINDOW = 3 * 60 * 1000;
const TYPING_FRESH = 2500;
const motion = !reducedMotion();

const roomId = (new URLSearchParams(location.search).get('r') || location.hash.slice(1) || '').trim().toLowerCase();

const state = {
  mode: 'local',
  room: null,
  me: { id: tabId(), ...getProfile() },
  conn: null,
  members: new Map(),
  rows: new Map(), // live typing rows on the stage, by member id
  lines: new Map(), // line id -> { line, el }
  pending: new Map(), // nonce -> line element
  group: null,
  welcomed: false,
  unread: 0,
  newBelow: 0,
  atBottom: true,
  history: [],
  status: 'connecting',
};

const el = {
  body: document.body,
  transcript: $('[data-transcript]'),
  lines: $('[data-lines]'),
  stage: $('[data-stage]'),
  jump: $('[data-jump]'),
  jumpText: $('[data-jump-text]'),
  composer: $('[data-composer]'),
  input: $('[data-input]'),
  count: $('[data-count]'),
  people: $('[data-people]'),
  peopleCount: $('[data-people-count]'),
  headAvatars: $('[data-head-avatars]'),
  headCount: $('[data-head-count]'),
  conn: $('[data-conn]'),
  connText: $('[data-conn-text]'),
};

const setView = (name) => (document.body.dataset.view = name);

boot();

async function boot() {
  initRipples();
  applyMe();
  if (!isValidRoomId(roomId)) return showMissing({ invalid: true });

  state.mode = await getMode();
  let room;
  try {
    room = await getRoom(roomId);
  } catch {
    return showMissing({ offline: true });
  }
  if (!room) return showMissing();
  state.room = room;
  renderRoomInfo();

  if (session.get('midsentence:autojoin') === roomId) {
    session.set('midsentence:autojoin', null);
    return enterRoom();
  }
  showLobby();
}

// ================================================================ identity

function applyMe() {
  const { me } = state;
  document.documentElement.style.setProperty('--me', me.color);
  for (const attr of ['data-me-avatar', 'data-you-avatar']) {
    const node = $(`[${attr}]`);
    if (!node) continue;
    const fresh = avatar(me);
    fresh.setAttribute(attr, '');
    node.replaceWith(fresh);
  }
  const youName = $('[data-you-name]');
  if (youName) youName.textContent = me.name || 'You';
}

function swatches(container, onPick) {
  const render = () => {
    container.replaceChildren(
      ...COLORS.map((c) => {
        const checked = c.value === state.me.color;
        return h('button.swatch', {
          type: 'button',
          role: 'radio',
          title: c.name,
          'aria-label': c.name,
          'aria-checked': String(checked),
          tabindex: checked ? '0' : '-1',
          style: { '--c': c.value },
          dataset: { color: c.value },
        });
      })
    );
  };
  render();
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.swatch');
    if (!btn) return;
    onPick(btn.dataset.color);
    for (const s of $$('.swatch', container)) {
      const on = s === btn;
      s.setAttribute('aria-checked', String(on));
      s.tabIndex = on ? 0 : -1;
    }
  });
  container.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const all = $$('.swatch', container);
    const i = all.indexOf(document.activeElement);
    const next = all[(i + dir + all.length) % all.length];
    next.focus();
    next.click();
  });
  return render;
}

// =================================================================== lobby

function showLobby() {
  setView('lobby');
  document.title = `Join ${state.room.name} · Midsentence`;
  const form = $('[data-join-form]');
  const name = $('[data-name-input]');
  const dice = $('[data-dice]');
  const error = $('[data-join-error]');
  const btn = $('[data-join-btn]');

  name.value = state.me.name;
  renderLobbyHere(state.room);
  swatches($('[data-swatches]'), (color) => {
    state.me.color = color;
    applyMe();
  });

  name.addEventListener('input', () => {
    state.me.name = name.value.trim();
    $('[data-you-name]').textContent = state.me.name || 'You';
    error.textContent = '';
  });
  dice.addEventListener('click', () => {
    name.value = randomName();
    name.dispatchEvent(new Event('input'));
    dice.classList.remove('is-rolling');
    void dice.offsetWidth;
    dice.classList.add('is-rolling');
    setTimeout(() => dice.classList.remove('is-rolling'), 600);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = name.value.replace(/\s+/g, ' ').trim();
    if (!value) {
      error.textContent = 'Pick a name so people know who’s typing.';
      form.classList.remove('has-error');
      void form.offsetWidth;
      form.classList.add('has-error');
      name.focus();
      return;
    }
    state.me.name = value.slice(0, 32);
    saveProfile(state.me);
    btn.classList.add('is-loading');
    btn.disabled = true;
    setTimeout(enterRoom, motion ? 260 : 0);
  });

  if (!isTouch()) setTimeout(() => btn.focus(), 400);

  const poll = setInterval(async () => {
    if (document.body.dataset.view !== 'lobby') return clearInterval(poll);
    const fresh = await getRoom(roomId).catch(() => null);
    if (fresh) renderLobbyHere(fresh);
  }, 5000);
}

function renderLobbyHere(room) {
  const here = $('[data-lobby-here]');
  if (room.people > 0) {
    here.replaceChildren(
      h('span.avatar-stack', room.members.slice(0, 4).map((m, i) => Object.assign(avatar(m), { style: `--c:${m.color};--i:${i}` }))),
      h('span.pulse-dot'),
      h('span', `${plural(room.people, 'person', 'people')} here now`)
    );
  } else {
    here.replaceChildren(h('span', 'Nobody’s here yet — you’ll be the first. ✨'));
  }
}

// ================================================================= missing

function showMissing({ invalid = false, offline = false, full = false } = {}) {
  setView('missing');
  document.title = 'Room not found · Midsentence';
  const title = $('[data-missing-title]');
  const text = $('[data-missing-text]');
  const revive = $('[data-revive]');
  const label = $('[data-revive-label]');

  if (invalid) {
    title.replaceChildren('No room ', h('span.serif.accent', 'here.'));
    text.textContent = 'This link doesn’t point to a room. Want to start a fresh one?';
    label.textContent = 'Create a room';
    revive.onclick = () => openCreateRoom(revive);
    return;
  }
  if (offline) {
    title.replaceChildren('Can’t reach ', h('span.serif.accent', 'Midsentence.'));
    text.textContent = 'The server didn’t answer. Check your connection and try again.';
    label.textContent = 'Try again';
    revive.onclick = () => location.reload();
    return;
  }
  if (full) {
    title.replaceChildren('This room is ', h('span.serif.accent', 'full.'));
    text.textContent = 'Rooms hold up to 50 people at once. Try again in a bit, or start your own.';
    label.textContent = 'Start a room';
    revive.onclick = () => openCreateRoom(revive);
    return;
  }

  const name = roomId
    .replace(/-[a-z0-9]{3}$/, '')
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
  label.textContent = `Start “${name || roomId}” again`;
  revive.onclick = async () => {
    revive.classList.add('is-loading');
    revive.disabled = true;
    try {
      state.room = await createRoom({ id: roomId, name, isPublic: false });
    } catch (err) {
      if (err.code !== 'exists') {
        revive.classList.remove('is-loading');
        revive.disabled = false;
        return toast(err.message || 'Couldn’t start the room.', { icon: '!' });
      }
      state.room = await getRoom(roomId);
    }
    renderRoomInfo();
    enterRoom();
  };
}

// ==================================================================== room

function renderRoomInfo() {
  const { room } = state;
  for (const node of $$('[data-room-name]')) node.textContent = room.name;
  for (const node of $$('[data-room-topic]')) node.textContent = room.topic || '';
  $('[data-invite-url]').textContent = shareUrl(roomId, state.mode).replace(/^https?:\/\//, '');
  $('[data-privacy-note]').textContent = room.isPublic === false ? 'Link-only room — it isn’t listed anywhere.' : 'Listed on the homepage. Anyone with the link can join.';
}

let roomReady = false;

function enterRoom() {
  setView('room');
  document.title = `${state.room.name} · Midsentence`;
  renderRoomInfo();
  if (!roomReady) {
    roomReady = true;
    initComposer();
    initSidebar();
    initShare();
    initTranscript();
    initKeyboard();
    initLifecycle();
  }
  connect();
  if (!isTouch()) el.input.focus();
  if (state.mode === 'local' && !session.get('midsentence:local-room-tip')) {
    session.set('midsentence:local-room-tip', true);
    setTimeout(() => toast('Local mode: open this room in another tab to see live typing.', { icon: 'ℹ', duration: 5200 }), 900);
  }
}

function connect() {
  state.conn?.close();
  state.conn = connectRoom({
    mode: state.mode,
    roomId,
    me: { id: state.me.id, name: state.me.name, color: state.me.color },
    on: {
      status: setStatus,
      welcome: onWelcome,
      join: ({ member }) => addMember(member, { announce: true }),
      leave: ({ id }) => removeMember(id),
      profile: ({ member }) => updateMember(member),
      type: ({ id, text, caret }) => onType(id, text, caret),
      line: ({ line, nonce }) => onLine(line, nonce),
      react: ({ line, reactions }) => onReact(line, reactions),
      error: onConnError,
      replaced: () => {
        // Another tab took over this seat (e.g. a duplicated tab) — take a new one.
        state.me.id = uid(12);
        session.set('midsentence:tab', state.me.id);
        connect();
      },
    },
  });
}

function setStatus(status) {
  const prev = state.status;
  state.status = status;
  el.conn.dataset.state = status;
  el.connText.textContent = { connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting', local: 'Local mode' }[status];
  el.conn.title = {
    connecting: 'Connecting to the room…',
    live: 'Connected — everyone sees your letters as you type',
    reconnecting: 'Connection lost. Your draft will sync when you’re back.',
    local: 'No server found — this room syncs between tabs in this browser',
  }[status];
  el.composer.classList.toggle('is-offline', status === 'reconnecting');
  if (status === 'reconnecting' && prev === 'live') toast('Connection lost — reconnecting…', { icon: '⚡' });
  if (status === 'live' && prev === 'reconnecting') toast('Back online', { icon: '✓', tone: 'success' });
}

function onConnError(err) {
  if (err.code === 'not_found') return showMissing();
  if (err.code === 'full') return showMissing({ full: true });
  toast(err.message || 'Something went wrong.', { icon: '!' });
}

function onWelcome(msg) {
  state.me.id = msg.you;
  if (msg.room) {
    state.room = { ...state.room, ...msg.room };
    renderRoomInfo();
  }

  // Members: reconcile quietly (this also runs after every reconnect).
  const incoming = new Map(msg.members.map((m) => [m.id, m]));
  for (const id of [...state.members.keys()]) if (!incoming.has(id)) removeMember(id, { quiet: true });
  for (const m of incoming.values()) {
    m.typedAt = m.text ? Date.now() - TYPING_FRESH : 0;
    if (state.members.has(m.id)) updateMember(m);
    else addMember(m, { announce: false });
    if (m.id !== state.me.id) onType(m.id, m.text || '', m.caret, { instant: true });
  }

  // Lines: add anything we haven't rendered yet.
  const first = !state.welcomed;
  for (const line of msg.lines) if (!state.lines.has(line.id)) appendLine(line, { animate: false });
  if (first) {
    state.welcomed = true;
    addSys(`You joined ${state.room.name}`, state.me.color);
    scrollToBottom(false);
  }
  updateEmpty();
}

// ================================================================= members

function addMember(m, { announce }) {
  if (state.members.has(m.id)) return updateMember(m);
  state.members.set(m.id, { ...m });
  const node = personNode(m);
  if (m.id === state.me.id) el.people.prepend(node);
  else el.people.append(node);
  refreshPerson(m.id);
  renderHead();
  if (announce && m.id !== state.me.id) addSys(`${m.name} joined`, m.color);
}

function removeMember(id, { quiet = false } = {}) {
  const m = state.members.get(id);
  if (!m) return;
  state.members.delete(id);
  const row = state.rows.get(id);
  if (row) {
    state.rows.delete(id);
    row.remove('clear');
  }
  const node = el.people.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (node) {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), motion ? 340 : 0);
  }
  renderHead();
  if (!quiet && id !== state.me.id) addSys(`${m.name} left`, m.color);
}

function updateMember(patch) {
  const m = state.members.get(patch.id);
  if (!m) return addMember(patch, { announce: false });
  const renamed = m.name !== patch.name || m.color !== patch.color;
  Object.assign(m, { name: patch.name, color: patch.color, away: patch.away });
  if (renamed) {
    const node = el.people.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
    node?.replaceWith(personNode(m, { animate: false }));
    state.rows.get(m.id)?.setMember(m);
    renderHead();
  }
  refreshPerson(m.id);
}

function personNode(m, { animate = true } = {}) {
  const node = h(
    'li.person',
    { style: { '--c': m.color }, dataset: { id: m.id } },
    avatar(m),
    h('span.person-name', m.name),
    m.id === state.me.id && h('span.tag', 'you'),
    h('span.person-state')
  );
  if (!animate) node.style.animation = 'none';
  return node;
}

function refreshPerson(id) {
  const m = state.members.get(id);
  const node = m && el.people.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!node) return;
  const typing = m.text && Date.now() - (m.typedAt || 0) < TYPING_FRESH;
  const status = m.away ? 'away' : typing ? 'typing' : m.text ? 'drafting' : 'here';
  if (node.dataset.status === status) return;
  node.dataset.status = status;
  node.classList.toggle('is-typing', status === 'typing');
  node.classList.toggle('is-away', status === 'away');
  const slot = $('.person-state', node);
  slot.replaceChildren(status === 'typing' ? h('span.typing-dots', h('i'), h('i'), h('i')) : status === 'here' ? '' : status);
}

function renderHead() {
  const all = [...state.members.values()];
  const n = all.length;
  el.peopleCount.textContent = n;
  if (el.headCount.textContent !== String(n)) {
    el.headCount.textContent = n;
    el.headCount.animate?.([{ transform: 'translateY(-50%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 300, easing: 'cubic-bezier(.34,1.56,.64,1)' });
  }
  el.headAvatars.replaceChildren(...all.slice(0, 4).map((m, i) => Object.assign(avatar(m), { style: `--c:${m.color};--i:${i}` })));
}

setInterval(() => {
  for (const id of state.members.keys()) refreshPerson(id);
}, 1000);

// =================================================================== stage

class LiveRow {
  constructor(member) {
    this.chars = [];
    this.spans = [];
    this.caret = h('span.caret');
    this.text = h('div.live-text', this.caret);
    this.name = h('span');
    this.who = h('div.live-who');
    this.el = h('div.live-wrap.is-entering', h('div.live-row', h('div.live-card', this.who, this.text)));
    this.setMember(member);
    el.stage.append(this.el);
    requestAnimationFrame(() => requestAnimationFrame(() => this.el.classList.remove('is-entering')));
  }

  setMember(m) {
    this.el.style.setProperty('--c', m.color);
    this.name.textContent = m.name;
    this.who.replaceChildren(avatar(m, 'sm'), this.name);
  }

  set(text, caret, { instant = false } = {}) {
    const next = Array.from(text);
    const { start, removed, inserted } = diffChars(this.chars, next);
    for (const s of this.spans.slice(start, start + removed)) s.remove();
    const anchor = this.spans[start + removed] || null;
    const fresh = inserted.map((ch) => h(instant || !motion ? 'span' : 'span.hot', ch));
    for (const s of fresh) this.text.insertBefore(s, anchor);
    this.spans.splice(start, removed, ...fresh);
    this.chars = next;
    // Put the caret exactly where they're editing.
    const at = Number.isInteger(caret) ? Array.from(text.slice(0, caret)).length : next.length;
    this.text.insertBefore(this.caret, this.spans[at] || null);

    this.el.classList.remove('is-idle');
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.el.classList.add('is-idle'), instant ? 0 : 3500);
  }

  remove(kind) {
    clearTimeout(this.idle);
    this.el.classList.add(kind === 'commit' ? 'is-commit' : 'is-clear');
    setTimeout(() => this.el.remove(), motion ? 380 : 0);
  }
}

function onType(id, text, caret, { instant = false } = {}) {
  const m = state.members.get(id);
  if (!m || id === state.me.id) return;
  const stick = isNearBottom();
  m.text = text;
  if (!instant) m.typedAt = Date.now();
  refreshPerson(id);

  let row = state.rows.get(id);
  if (!text) {
    if (row && !row.pendingRemoval) {
      // Wait a beat: if a line from them lands, this was a commit, not a clear.
      row.pendingRemoval = setTimeout(() => {
        state.rows.delete(id);
        row.remove(row.committed ? 'commit' : 'clear');
      }, 120);
    }
    return;
  }
  if (row?.pendingRemoval) {
    clearTimeout(row.pendingRemoval);
    row.pendingRemoval = null;
    row.committed = false;
  }
  if (!row) state.rows.set(id, (row = new LiveRow(m)));
  row.set(text, caret, { instant });
  if (stick) keepBottom();
}

// ============================================================== transcript

function initTranscript() {
  el.transcript.addEventListener(
    'scroll',
    () => {
      state.atBottom = isNearBottom();
      if (state.atBottom) hideJump();
    },
    { passive: true }
  );
  // The stage and composer grow and shrink — keep the newest line in view.
  new ResizeObserver(() => state.atBottom && keepBottom()).observe(el.transcript);
  el.jump.addEventListener('click', () => scrollToBottom(true));
}

const isNearBottom = () => el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight < 120;
const keepBottom = () => (el.transcript.scrollTop = el.transcript.scrollHeight);

function scrollToBottom(smooth) {
  el.transcript.scrollTo({ top: el.transcript.scrollHeight, behavior: smooth && motion ? 'smooth' : 'auto' });
  hideJump();
}

function hideJump() {
  state.newBelow = 0;
  el.jump.hidden = true;
}

function updateEmpty() {
  el.transcript.classList.toggle('has-lines', state.lines.size > 0 || state.pending.size > 0);
}

function onLine(line, nonce) {
  const pendingEl = nonce && state.pending.get(nonce);
  if (pendingEl) {
    // Our own line came back from the server — settle the optimistic copy.
    state.pending.delete(nonce);
    pendingEl.classList.remove('is-pending');
    pendingEl.dataset.id = line.id;
    state.lines.set(line.id, { line, el: pendingEl });
    return;
  }
  if (state.lines.has(line.id)) return;

  const row = state.rows.get(line.author.id);
  if (row?.pendingRemoval) row.committed = true;

  const stick = isNearBottom();
  appendLine(line, { animate: true });
  updateEmpty();
  if (stick) scrollToBottom(true);
  else if (line.author.id !== state.me.id) {
    state.newBelow++;
    el.jumpText.textContent = state.newBelow === 1 ? '1 new line' : `${state.newBelow} new lines`;
    el.jump.hidden = false;
  }
  if (document.hidden && line.author.id !== state.me.id) {
    state.unread++;
    document.title = `(${state.unread}) ${state.room.name} · Midsentence`;
  }
}

function appendLine(line, { animate = true, pending = false } = {}) {
  const author = line.author;
  const last = state.group;
  const grouped = last && last.authorId === author.id && line.ts - last.ts < GROUP_WINDOW;

  if (!grouped) {
    const mine = author.id === state.me.id;
    const time = new Date(line.ts);
    const group = h(
      'div.group',
      { style: { '--c': author.color } },
      avatar(author),
      h(
        'div.group-head',
        h('span.group-name', author.name),
        mine && h('span.tag', 'you'),
        h('time.group-time', { datetime: time.toISOString(), title: time.toLocaleString() }, clock(line.ts))
      )
    );
    if (!animate) group.style.animation = 'none';
    el.lines.append(group);
    state.group = { el: group, authorId: author.id, ts: line.ts };
  }
  state.group.ts = line.ts;

  const node = h(
    `div.line${grouped && animate ? '.is-new' : ''}${pending ? '.is-pending' : ''}`,
    { dataset: { id: line.id } },
    h('span.line-text', line.text),
    h('div.reactions'),
    h(
      'div.line-tools',
      h('button.react-btn', { type: 'button', 'aria-label': 'Add reaction', title: 'React', html: smileIcon })
    )
  );
  state.group.el.append(node);
  if (!pending) state.lines.set(line.id, { line, el: node });
  renderReactions(node, line.reactions || {});
  return node;
}

function addSys(text, color) {
  const node = h('div.sys', { style: { '--c': color } }, h('i'), h('span', text), h('time', clock(Date.now())));
  const stick = isNearBottom();
  el.lines.append(node);
  state.group = null;
  if (stick) scrollToBottom(true);
}

// --------------------------------------------------------------- reactions

const smileIcon = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><path d="M7 11.5c.7 1 1.8 1.6 3 1.6s2.3-.6 3-1.6"/><circle cx="7.6" cy="8.2" r=".6" fill="currentColor"/><circle cx="12.4" cy="8.2" r=".6" fill="currentColor"/></svg>';

let menu = null;

function closeMenu() {
  if (!menu) return;
  menu.node.closest('.line')?.classList.remove('has-menu');
  menu.node.remove();
  menu = null;
}

function openMenu(lineEl) {
  closeMenu();
  const id = lineEl.dataset.id;
  const node = h(
    'div.react-menu',
    { role: 'menu', 'aria-label': 'Reactions' },
    REACTIONS.map((emoji) =>
      h('button', {
        type: 'button',
        role: 'menuitem',
        'aria-label': `React ${emoji}`,
        onclick: (e) => {
          e.stopPropagation();
          react(id, emoji);
          closeMenu();
        },
      }, emoji)
    )
  );
  const top = lineEl.getBoundingClientRect().top - el.transcript.getBoundingClientRect().top;
  if (top < 64) node.classList.add('is-below');
  $('.line-tools', lineEl).append(node);
  lineEl.classList.add('has-menu');
  menu = { node, id };
  node.querySelector('button').focus({ preventScroll: true });
}

function react(id, emoji) {
  if (!state.lines.has(id)) return; // still pending
  state.conn?.react(id, emoji);
}

function onReact(id, reactions) {
  const entry = state.lines.get(id);
  if (!entry) return;
  const before = entry.line.reactions || {};
  const changed = Object.keys(reactions).find((k) => (reactions[k]?.length || 0) > (before[k]?.length || 0));
  entry.line.reactions = reactions;
  renderReactions(entry.el, reactions, changed);
}

function renderReactions(lineEl, reactions, pop) {
  const box = $('.reactions', lineEl);
  const id = lineEl.dataset.id;
  box.replaceChildren(
    ...Object.entries(reactions).map(([emoji, who]) => {
      const mine = who.includes(state.me.id);
      const names = who.map((w) => (w === state.me.id ? 'You' : state.members.get(w)?.name)).filter(Boolean);
      const chip = h(
        `button.rx${mine ? '.is-mine' : ''}${emoji === pop ? '.is-pop' : ''}`,
        {
          type: 'button',
          'aria-pressed': String(mine),
          'aria-label': `${emoji} ${who.length}`,
          title: names.length ? names.join(', ') : '',
          onclick: () => react(id, emoji),
        },
        h('span', emoji),
        h('span', who.length)
      );
      return chip;
    })
  );
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.react-btn');
  if (btn) {
    const line = btn.closest('.line');
    if (menu && line.contains(menu.node)) closeMenu();
    else openMenu(line);
    return;
  }
  if (menu && !menu.node.contains(e.target)) closeMenu();
});

// ================================================================ composer

function initComposer() {
  const { input, composer } = el;
  let queued = false;
  let keyTimer;
  let caretTimer;

  const send = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      state.conn?.type(input.value, input.selectionStart);
    });
  };

  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  };

  const counter = () => {
    const n = input.value.length;
    el.count.textContent = n > 400 ? `${n}/500` : '';
    el.count.classList.toggle('is-near', n > 400 && n < 500);
    el.count.classList.toggle('is-max', n >= 500);
  };

  const changed = () => {
    autosize();
    counter();
    composer.classList.toggle('is-live', input.value.length > 0);
    send();
  };

  input.addEventListener('input', () => {
    changed();
    composer.classList.add('is-key');
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => composer.classList.remove('is-key'), 110);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      if (input.value) {
        input.value = '';
        changed();
      } else input.blur();
    } else if (e.key === 'ArrowUp' && !input.value && state.history.length) {
      e.preventDefault();
      input.value = state.history[state.history.length - 1];
      input.setSelectionRange(input.value.length, input.value.length);
      changed();
    }
  });

  // Let others see the caret move when you click or arrow around.
  document.addEventListener('selectionchange', () => {
    if (document.activeElement !== input || !input.value) return;
    clearTimeout(caretTimer);
    caretTimer = setTimeout(send, 60);
  });

  function commit() {
    const text = input.value.replace(/\s+$/g, '').replace(/^\s+/g, '');
    if (!text) {
      composer.animate?.([{ transform: 'translateX(0)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'none' }], { duration: 240 });
      return;
    }
    if (motion) fly(text);
    const nonce = uid(10);
    input.value = '';
    changed();
    const node = appendLine(
      { id: `pending-${nonce}`, author: { id: state.me.id, name: state.me.name, color: state.me.color }, text, ts: Date.now(), reactions: {} },
      { animate: true, pending: true }
    );
    state.pending.set(nonce, node);
    updateEmpty();
    state.conn?.commit(text, nonce);
    state.history.push(text);
    if (state.history.length > 50) state.history.shift();
    scrollToBottom(true);
  }

  function fly(text) {
    const box = input.getBoundingClientRect();
    const host = composer.getBoundingClientRect();
    const ghost = h('div.flyer', {
      style: { left: `${box.left - host.left}px`, top: `${box.top - host.top + 5}px`, width: `${box.width}px` },
    }, text);
    composer.append(ghost);
    ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
  }
}

// ================================================================= sidebar

function initSidebar() {
  const toggle = $('[data-people-toggle]');
  const backdrop = $('[data-sheet-backdrop]');
  const sidebar = $('[data-sidebar]');
  const mobile = matchMedia('(max-width: 860px)');

  if (store.get('midsentence:sidebar-hidden')) document.body.classList.add('sidebar-hidden');

  const setSheet = (open) => {
    document.body.classList.toggle('sheet-open', open);
    sidebar.style.transform = '';
  };
  toggle.addEventListener('click', () => {
    if (mobile.matches) return setSheet(!document.body.classList.contains('sheet-open'));
    const hidden = document.body.classList.toggle('sidebar-hidden');
    store.set('midsentence:sidebar-hidden', hidden);
  });
  backdrop.addEventListener('click', () => setSheet(false));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && document.body.classList.contains('sheet-open') && setSheet(false));

  // Drag the sheet down to dismiss it.
  let startY = null;
  sidebar.addEventListener('pointerdown', (e) => {
    if (!mobile.matches || sidebar.scrollTop > 0 || e.target.closest('button, input')) return;
    startY = e.clientY;
  });
  window.addEventListener('pointermove', (e) => {
    if (startY == null) return;
    const dy = Math.max(0, e.clientY - startY);
    sidebar.style.transition = 'none';
    sidebar.style.transform = `translateY(${dy}px)`;
  });
  window.addEventListener('pointerup', (e) => {
    if (startY == null) return;
    const dy = e.clientY - startY;
    startY = null;
    sidebar.style.transition = '';
    sidebar.style.transform = '';
    if (dy > 90) setSheet(false);
  });

  // Edit your own name and color live.
  const nameInput = $('[data-me-name]');
  nameInput.value = state.me.name;
  const saveName = () => {
    const value = nameInput.value.replace(/\s+/g, ' ').trim().slice(0, 32);
    if (!value) {
      nameInput.value = state.me.name;
      return;
    }
    if (value === state.me.name) return;
    state.me.name = value;
    saveProfile(state.me);
    applyMe();
    state.conn?.profile({ name: value, color: state.me.color });
    toast(`You’re now ${value}`, { icon: '✎' });
  };
  $('[data-me-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    saveName();
    nameInput.blur();
  });
  nameInput.addEventListener('blur', saveName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      nameInput.blur();
    }
  });

  swatches($('[data-me-swatches]'), (color) => {
    state.me.color = color;
    saveProfile(state.me);
    applyMe();
    state.conn?.profile({ name: state.me.name, color });
  });
}

// =================================================================== share

function initShare() {
  const headBtn = $('[data-share]');
  const label = $('[data-share-label]');
  const side = $('[data-share-side]');
  let timer;

  async function share(source) {
    const url = shareUrl(roomId, state.mode);
    if (navigator.share && isTouch()) {
      try {
        await navigator.share({ title: state.room.name, text: `Join me in “${state.room.name}” on Midsentence`, url });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    const ok = await copyText(url);
    if (!ok) return toast(url, { duration: 6000 });
    clearTimeout(timer);
    headBtn.classList.add('is-copied');
    side.classList.add('is-copied');
    label.textContent = 'Copied';
    $('.invite-copy', side).textContent = 'Copied';
    timer = setTimeout(() => {
      headBtn.classList.remove('is-copied');
      side.classList.remove('is-copied');
      label.textContent = 'Invite';
      $('.invite-copy', side).textContent = 'Copy';
    }, 1800);
    if (source !== headBtn) toast('Invite link copied — send it to anyone', { icon: '🔗', tone: 'success' });
  }

  headBtn.addEventListener('click', () => share(headBtn));
  side.addEventListener('click', () => share(side));
  $('[data-share-empty]').addEventListener('click', (e) => share(e.currentTarget));
}

// ================================================================ keyboard

function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (document.body.dataset.view !== 'room' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === 'Escape' && menu) return closeMenu();
    if (e.key === '/') {
      e.preventDefault();
      el.input.focus();
      return;
    }
    // Just start typing — anywhere on the page.
    if (e.key.length === 1 && !t.closest?.('button, a')) el.input.focus();
  });
}

// =============================================================== lifecycle

function initLifecycle() {
  document.addEventListener('visibilitychange', () => {
    state.conn?.away(document.hidden);
    if (!document.hidden && state.unread) {
      state.unread = 0;
      document.title = `${state.room.name} · Midsentence`;
    }
  });
  window.addEventListener('pagehide', () => state.conn?.close());
  window.addEventListener('pageshow', (e) => e.persisted && document.body.dataset.view === 'room' && connect());
  $('[data-leave]').addEventListener('click', () => state.conn?.close());
}
