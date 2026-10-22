import { $, $$, h, avatar, clamp, sleep, reducedMotion, isTouch, timeAgo, plural, diffChars } from './lib/util.js';
import { getMode, watchRooms, roomHref } from './lib/api.js';
import { COLORS, randomName } from './lib/identity.js';
import { openCreateRoom, createAndEnter, initSpotlight, initMagnetic, initReveal, initThemeToggle, arrowIcon } from './lib/ui.js';

const motion = !reducedMotion();
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** Run `fn` only while `el` is on screen and the tab is visible. */
function whileVisible(el) {
  let visible = false;
  const waiters = [];
  const flush = () => visible && document.visibilityState === 'visible' && waiters.splice(0).forEach((r) => r());
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    flush();
  }).observe(el);
  document.addEventListener('visibilitychange', flush);
  return {
    get on() {
      return visible && document.visibilityState === 'visible';
    },
    async wait(ms) {
      await sleep(ms);
      while (!(visible && document.visibilityState === 'visible')) await new Promise((r) => waiters.push(r));
    },
  };
}

/** One rooms subscription for the whole page, fanned out to every section. */
const onRooms = (() => {
  const listeners = new Set();
  let latest = null;
  watchRooms((rooms) => {
    latest = rooms;
    listeners.forEach((fn) => fn(rooms));
  });
  return (fn) => {
    listeners.add(fn);
    if (latest) fn(latest);
  };
})();

/** Letters that land one at a time with a marker highlight in `color`. */
function freshSpan(ch, color) {
  return h('span.fresh', { style: { '--c': color } }, ch);
}

initThemeToggle($('[data-theme-toggle]'));
initMode();
initNav();
initField();
initHero();
initDemo();
initStatement();
initStory();
initFeatures();
initRooms();
initFaq();
initStart();
initFooter();
initShortcuts();
initSpotlight();
initMagnetic();
initReveal();

for (const btn of $$('[data-create-room]')) btn.addEventListener('click', () => openCreateRoom(btn));

// ------------------------------------------------------------------- mode

async function initMode() {
  const mode = await getMode();
  document.documentElement.dataset.mode = mode === 'relay' ? 'relay' : 'server';
}

// -------------------------------------------------------------------- nav

function initNav() {
  const nav = $('[data-nav]');
  const links = $('[data-nav-links]');
  const burger = $('[data-burger]');
  const menu = $('[data-mobile-menu]');

  for (const a of $$('a', links)) {
    a.addEventListener('pointerenter', () => {
      links.style.setProperty('--x', `${a.offsetLeft}px`);
      links.style.setProperty('--w', `${a.offsetWidth}px`);
      links.classList.add('is-hovering');
      requestAnimationFrame(() => links.classList.add('was-hovering'));
    });
  }
  links.addEventListener('pointerleave', () => links.classList.remove('is-hovering', 'was-hovering'));

  let lastY = scrollY;
  let ticking = false;
  addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const y = scrollY;
        nav.classList.toggle('is-scrolled', y > 12);
        if (!menu.classList.contains('is-open')) {
          if (y > 640 && y - lastY > 6) nav.classList.add('is-hidden');
          else if (lastY - y > 6 || y < 640) nav.classList.remove('is-hidden');
        }
        lastY = y;
      });
    },
    { passive: true }
  );

  const map = new Map($$('a', links).map((a) => [a.getAttribute('href').slice(1), a]));
  const spy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const a of map.values()) a.classList.remove('is-active');
        map.get(entry.target.id)?.classList.add('is-active');
      }
    },
    { rootMargin: '-45% 0px -50% 0px' }
  );
  for (const id of map.keys()) {
    const section = document.getElementById(id);
    if (section) spy.observe(section);
  }
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) for (const a of map.values()) a.classList.remove('is-active');
  }, { rootMargin: '0px 0px -60% 0px' }).observe($('.hero'));

  $$('a', menu).forEach((a, i) => a.style.setProperty('--i', i));
  const setMenu = (open) => {
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    if (open) {
      menu.hidden = false;
      requestAnimationFrame(() => menu.classList.add('is-open'));
      nav.classList.remove('is-hidden');
    } else {
      menu.classList.remove('is-open');
      setTimeout(() => !menu.classList.contains('is-open') && (menu.hidden = true), 300);
    }
  };
  burger.addEventListener('click', () => setMenu(burger.getAttribute('aria-expanded') !== 'true'));
  menu.addEventListener('click', (e) => e.target.closest('a, button') && setMenu(false));
  document.addEventListener('click', (e) => menu.classList.contains('is-open') && !nav.contains(e.target) && setMenu(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('is-open')) {
      setMenu(false);
      burger.focus();
    }
  });
  matchMedia('(min-width: 901px)').addEventListener('change', (e) => e.matches && setMenu(false));
}

// ------------------------------------------------------- letter field (hero)

function initField() {
  const canvas = $('[data-field]');
  const hero = $('.hero');
  const ctx = canvas.getContext('2d');
  const base = document.createElement('canvas');
  const bctx = base.getContext('2d');
  const CHARS = 'abcdefghijklmnopqrstuvwxyz';
  const CELL = 28;
  const R = 150;
  let cols = 0;
  let rows = 0;
  let dpr = 1;
  let letters = [];
  let heat = new Float32Array(0);
  let ink = '18, 17, 15';
  let pointer = null;
  let running = false;
  let visible = true;

  const font = () => `500 ${13}px Inter, system-ui, sans-serif`;
  const readInk = () => (ink = getComputedStyle(document.documentElement).getPropertyValue('--field-ink').trim() || ink);

  function drawCell(c, i, alpha) {
    const x = (i % cols) * CELL + CELL / 2;
    const y = Math.floor(i / cols) * CELL + CELL / 2;
    c.fillStyle = `rgba(${ink}, ${alpha})`;
    c.fillText(letters[i], x, y);
  }

  function paintBase() {
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, base.width, base.height);
    bctx.font = font();
    bctx.textAlign = 'center';
    bctx.textBaseline = 'middle';
    for (let i = 0; i < letters.length; i++) drawCell(bctx, i, 0.075);
  }

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    const w = hero.clientWidth;
    const hgt = hero.clientHeight;
    for (const c of [canvas, base]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    }
    cols = Math.ceil(w / CELL);
    rows = Math.ceil(hgt / CELL);
    letters = Array.from({ length: cols * rows }, () => pick(CHARS));
    heat = new Float32Array(cols * rows);
    readInk();
    paintBase();
    frame(true);
  }

  function scramble(i) {
    letters[i] = pick(CHARS);
    const x = (i % cols) * CELL;
    const y = Math.floor(i / cols) * CELL;
    bctx.clearRect(x, y, CELL, CELL);
    drawCell(bctx, i, 0.075);
  }

  function frame(once = false) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = font();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (pointer) {
      const c0 = Math.max(0, Math.floor((pointer.x - R) / CELL));
      const c1 = Math.min(cols - 1, Math.ceil((pointer.x + R) / CELL));
      const r0 = Math.max(0, Math.floor((pointer.y - R) / CELL));
      const r1 = Math.min(rows - 1, Math.ceil((pointer.y + R) / CELL));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const d = Math.hypot(c * CELL + CELL / 2 - pointer.x, r * CELL + CELL / 2 - pointer.y);
          if (d > R) continue;
          const i = r * cols + c;
          const t = 1 - d / R;
          if (t > heat[i]) heat[i] = t;
        }
      }
    }
    // A few letters flicker on their own, like someone typing somewhere.
    for (let k = 0; k < 2; k++) {
      const i = Math.floor(Math.random() * heat.length);
      heat[i] = Math.max(heat[i], 0.55);
    }

    let hot = false;
    for (let i = 0; i < heat.length; i++) {
      const t = heat[i];
      if (t < 0.02) continue;
      hot = true;
      if (Math.random() < t * 0.08) scramble(i);
      const x = (i % cols) * CELL;
      const y = Math.floor(i / cols) * CELL;
      if (t > 0.72) {
        ctx.fillStyle = `rgba(215, 255, 58, ${(t - 0.72) * 3})`;
        ctx.beginPath();
        ctx.roundRect(x + 4, y + 4, CELL - 8, CELL - 8, 5);
        ctx.fill();
        ctx.fillStyle = `rgba(18, 17, 15, ${0.25 + t * 0.6})`;
        ctx.fillText(letters[i], x + CELL / 2, y + CELL / 2);
      } else drawCell(ctx, i, 0.075 + t * 0.55);
      heat[i] = t * 0.93;
    }
    if (once) return;
    if ((hot || pointer) && visible && !document.hidden) requestAnimationFrame(() => frame());
    else running = false;
  }

  const kick = () => {
    if (running || !motion) return;
    running = true;
    requestAnimationFrame(() => frame());
  };

  document.fonts.ready.then(() => {
    resize();
    canvas.classList.add('is-ready');
    kick();
  });
  new ResizeObserver(() => cols && resize()).observe(hero);
  new MutationObserver(() => {
    readInk();
    paintBase();
    frame(true);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible) kick();
  }).observe(hero);

  if (isTouch() || !motion) {
    // Ambient flicker only.
    if (motion) setInterval(() => visible && !document.hidden && kick(), 900);
    return;
  }
  hero.addEventListener('pointermove', (e) => {
    const r = hero.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    kick();
  });
  hero.addEventListener('pointerleave', () => (pointer = null));
  setInterval(() => visible && !document.hidden && kick(), 1200);
}

// ------------------------------------------------------------------- hero

function initHero() {
  const text = $('[data-live-text]');
  const stack = $('[data-live-avatars]');
  let last = '';
  onRooms((rooms) => {
    const people = rooms.reduce((n, r) => n + (r.people || 0), 0);
    const live = rooms.filter((r) => r.people > 0).length;
    const next = people
      ? `${plural(people, 'person', 'people')} talking in ${plural(live, 'room')} right now`
      : `${plural(rooms.length, 'room')} open — be the first one in`;
    if (next !== last) {
      last = next;
      text.replaceChildren(h('span.flip', next));
    }
    const faces = rooms.flatMap((r) => r.members || []).slice(0, 3);
    stack.replaceChildren(...faces.map((m, i) => Object.assign(avatar(m, 'sm'), { style: `--c:${m.color};--i:${i}` })));
  });
}

// ------------------------------------------------------------------- demo

function initDemo() {
  const demo = $('[data-demo]');
  const card = $('.demo-card', demo);
  const lines = $('[data-demo-lines]');
  const stage = $('[data-demo-stage]');
  const input = $('[data-demo-input]');
  const enterKey = $('.demo-composer kbd', demo);
  const gate = whileVisible(demo);

  const PEOPLE = {
    maya: { name: 'Maya', color: '#ff7eb6' },
    leo: { name: 'Leo', color: '#4cb2ff' },
    ana: { name: 'Ana', color: '#ffbe3d' },
    you: { name: 'You', color: '#c6f432' },
  };
  $('[data-demo-avatars]').append(...['maya', 'leo', 'ana'].map((k, i) => Object.assign(avatar(PEOPLE[k], 'sm'), { style: `--c:${PEOPLE[k].color};--i:${i}` })));

  const SCRIPT = [
    { who: 'maya', text: 'okay, who else is still up?' },
    { who: 'leo', text: 'me. fixing a bug that refuses to die', typo: { at: 17, wrong: 'rh' }, overlap: true },
    { who: 'ana', text: 'wait — you can see me typing??', typo: { at: 20, wrong: 'yp' } },
    { who: 'maya', text: 'every single letter 👀', overlap: true },
    { who: 'leo', text: 'no more rewriting my hot takes in secret' },
  ];
  const REPLIES = [
    'ha — I watched every letter of that',
    'okay you type fast',
    'the little pause before the last word 👀',
    'wait, say more',
    'this is why there’s no send button',
  ];

  let visitorBusy = false;
  let visitorRow = null;
  let visitorPrev = [];

  function row(person) {
    const text = h('div.live-text');
    const caret = h('span.caret', { style: { '--c': person.color } });
    text.append(caret);
    const el = h(
      'div.live-row.is-entering',
      { style: { '--c': person.color } },
      h('div', h('div.live-card', h('div.live-who', avatar(person, 'sm'), person.name), text))
    );
    stage.append(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('is-entering')));
    return {
      el,
      text,
      caret,
      add(ch) {
        text.insertBefore(freshSpan(ch, person.color), caret);
      },
      back() {
        caret.previousSibling?.remove();
      },
      async leave() {
        el.classList.add('is-leaving');
        await sleep(motion ? 380 : 0);
        el.remove();
      },
    };
  }

  function post(key, text, { you = false } = {}) {
    const p = PEOPLE[key];
    const msg = h(`div.demo-msg${you ? '.is-you' : ''}`, avatar(p), h('div', h('b', p.name), h('p', text), h('div.rx-row')));
    lines.append(msg);
    while (lines.children.length > 8) lines.firstElementChild.remove();
    return msg;
  }

  function react(msg, emoji) {
    const rowEl = $('.rx-row', msg);
    const existing = [...rowEl.children].find((c) => c.dataset.emoji === emoji);
    if (existing) {
      const n = Number(existing.dataset.n) + 1;
      existing.dataset.n = n;
      existing.lastChild.textContent = n;
      existing.classList.remove('is-pop');
      void existing.offsetWidth;
      existing.classList.add('is-pop');
    } else rowEl.append(h('span.rx', { dataset: { emoji, n: 1 } }, h('span', emoji), h('span', '1')));
  }

  const pace = (ch) => (/[.,?!—]/.test(ch) ? rand(160, 300) : ch === ' ' ? rand(60, 130) : rand(38, 95));

  async function typeLine({ who, text, typo }) {
    const r = row(PEOPLE[who]);
    const letters = [...text];
    for (let i = 0; i < letters.length; i++) {
      if (typo && i === typo.at) {
        for (const ch of typo.wrong) {
          r.add(ch);
          await gate.wait(rand(50, 100));
        }
        await gate.wait(rand(260, 420));
        for (let k = 0; k < typo.wrong.length; k++) {
          r.back();
          await gate.wait(rand(55, 85));
        }
      }
      r.add(letters[i]);
      await gate.wait(pace(letters[i]));
    }
    await gate.wait(rand(450, 750));
    await r.leave();
    return post(who, text);
  }

  const seed = () => {
    for (const [who, text] of [['ana', 'back from the kitchen ☕'], ['leo', 'the lobby is weirdly cozy tonight']]) post(who, text).style.animation = 'none';
  };

  async function loop() {
    for (;;) {
      if (!lines.children.length) seed();
      await gate.wait(700);
      let previous = Promise.resolve();
      for (const line of SCRIPT) {
        while (visitorBusy) await gate.wait(400);
        if (!line.overlap) await previous;
        await gate.wait(line.overlap ? 1400 : 350);
        previous = typeLine(line);
      }
      await previous;
      await gate.wait(4200);
      while (visitorBusy) await gate.wait(400);
      for (const msg of [...lines.children]) {
        msg.classList.add('is-leaving');
        await sleep(60);
      }
      await gate.wait(600);
      lines.replaceChildren();
    }
  }

  // The visitor's own typing shows up as a live row — exactly what others would see.
  function syncVisitor() {
    const next = [...input.value];
    if (!next.length) {
      if (visitorRow) {
        const r = visitorRow;
        visitorRow = null;
        r.leave();
      }
      visitorPrev = [];
      return;
    }
    visitorRow ||= row(PEOPLE.you);
    const { start, removed, inserted } = diffChars(visitorPrev, next);
    const spans = [...visitorRow.text.querySelectorAll('span:not(.caret)')];
    spans.slice(start, start + removed).forEach((s) => s.remove());
    const anchor = spans[start + removed] || visitorRow.caret;
    for (const ch of inserted) visitorRow.text.insertBefore(freshSpan(ch, PEOPLE.you.color), anchor);
    const at = Array.from(input.value.slice(0, input.selectionStart ?? input.value.length)).length;
    const all = [...visitorRow.text.querySelectorAll('span:not(.caret)')];
    visitorRow.text.insertBefore(visitorRow.caret, all[at] || null);
    visitorPrev = next;
  }

  async function respond(msg, text) {
    await sleep(700);
    react(msg, '🔥');
    await sleep(500);
    const who = pick(['maya', 'leo', 'ana']);
    let reply = pick(REPLIES);
    if (/\?\s*$/.test(text)) reply = 'good question — you can literally watch me think';
    else if (/\b(hi|hey|hello|yo|sup)\b/i.test(text)) reply = 'hey! 👋 welcome in';
    const answer = await typeLine({ who, text: reply });
    await sleep(900);
    react(answer, '😂');
  }

  input.addEventListener('input', () => {
    visitorBusy = true;
    syncVisitor();
  });
  input.addEventListener('keyup', syncVisitor);
  input.addEventListener('click', syncVisitor);
  input.addEventListener('blur', () => !input.value && (visitorBusy = false));
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      syncVisitor();
      return;
    }
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const text = input.value.trim();
    enterKey.classList.add('is-pressed');
    setTimeout(() => enterKey.classList.remove('is-pressed'), 140);
    if (!text) return;
    const r = visitorRow;
    visitorRow = null;
    visitorPrev = [];
    input.value = '';
    await r?.leave();
    const msg = post('you', text, { you: true });
    await respond(msg, text);
    if (!input.value) visitorBusy = false;
  });

  if (motion) loop();
  else for (const line of SCRIPT) post(line.who, line.text);

  // A slight 3D lean towards the cursor.
  if (!isTouch() && motion) {
    demo.addEventListener('pointermove', (e) => {
      const r = demo.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      card.style.setProperty('--ry', `${x * 7}deg`);
      card.style.setProperty('--rx', `${-y * 5}deg`);
    });
    demo.addEventListener('pointerleave', () => {
      card.style.setProperty('--ry', '0deg');
      card.style.setProperty('--rx', '0deg');
    });
  }
}

// -------------------------------------------------------------- statement

function initStatement() {
  const track = $('[data-marquee]');
  const row = track.firstElementChild;
  for (let i = 0; i < 2; i++) track.append(Object.assign(row.cloneNode(true), { ariaHidden: 'true' }));
  if (!motion) return;
  const gate = whileVisible(track);
  let x = 0;
  let dir = 1;
  let boost = 0;
  let lastY = scrollY;
  addEventListener(
    'scroll',
    () => {
      const dy = scrollY - lastY;
      lastY = scrollY;
      if (dy) dir = Math.sign(dy);
      boost = clamp(boost + Math.abs(dy) * 0.08, 0, 14);
    },
    { passive: true }
  );
  const tick = () => {
    if (gate.on) {
      const w = row.offsetWidth;
      x -= (0.6 + boost) * dir;
      boost *= 0.92;
      if (x <= -w) x += w;
      if (x > 0) x -= w;
      track.style.transform = `translate3d(${x}px, 0, 0)`;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ------------------------------------------------------------------ story

function initStory() {
  const device = $('[data-story-device]');
  const linesEl = $('[data-story-lines]');
  const stageEl = $('[data-story-stage]');
  const avatars = $('[data-story-avatars]');
  const steps = $$('.story-step');
  const gate = whileVisible(device);
  const P = {
    jo: { name: 'Jo', color: '#4cb2ff' },
    maya: { name: 'Maya', color: '#ff7eb6' },
    kofi: { name: 'Kofi', color: '#3dd68c' },
  };
  const BASE = [
    ['kofi', 'anyone still thinking about the launch?'],
    ['maya', 'constantly. I have notes'],
  ];
  let state = -1;
  let token = 0;

  const setPeople = (keys) => avatars.replaceChildren(...keys.map((k, i) => Object.assign(avatar(P[k], 'sm'), { style: `--c:${P[k].color};--i:${i}` })));
  const msg = (key, text) => h('div.demo-msg', avatar(P[key]), h('div', h('b', P[key].name), h('p', text)));
  const reset = (pairs) => {
    linesEl.replaceChildren(...pairs.map(([k, t]) => Object.assign(msg(k, t), { style: 'animation:none' })));
    stageEl.replaceChildren();
    device.classList.remove('is-empty');
  };

  function liveRow(person) {
    const text = h('div.live-text');
    const caret = h('span.caret', { style: { '--c': person.color } });
    text.append(caret);
    const el = h('div.live-row.is-entering', { style: { '--c': person.color } }, h('div', h('div.live-card', h('div.live-who', avatar(person, 'sm'), person.name), text)));
    stageEl.append(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('is-entering')));
    return { el, text, caret };
  }

  async function type(r, color, s, my) {
    for (const ch of [...s]) {
      if (my !== token) return false;
      r.text.insertBefore(freshSpan(ch, color), r.caret);
      await gate.wait(ch === ' ' ? rand(60, 120) : rand(40, 90));
    }
    return my === token;
  }
  async function erase(r, n, my) {
    for (let i = 0; i < n; i++) {
      if (my !== token) return false;
      r.caret.previousSibling?.remove();
      await gate.wait(45);
    }
    return my === token;
  }
  async function commit(r, key, text) {
    r.el.classList.add('is-leaving');
    await sleep(360);
    r.el.remove();
    linesEl.append(msg(key, text));
    while (linesEl.children.length > 5) linesEl.firstElementChild.remove();
  }

  const scenes = [
    // 01 — someone is mid-sentence, editing as they go
    async (my) => {
      reset(BASE);
      setPeople(['jo', 'maya', 'kofi']);
      while (my === token) {
        const r = liveRow(P.jo);
        if (!(await type(r, P.jo.color, 'so here’s my half-baked idea', my))) return;
        await gate.wait(700);
        if (!(await erase(r, 15, my))) return;
        if (!(await type(r, P.jo.color, 'brilliant idea 💡', my))) return;
        await gate.wait(1600);
        if (my !== token) return;
        r.el.classList.add('is-leaving');
        await gate.wait(500);
        r.el.remove();
      }
    },
    // 02 — Enter moves the line up, the next thought starts
    async (my) => {
      reset(BASE);
      setPeople(['jo', 'maya', 'kofi']);
      while (my === token) {
        const a = liveRow(P.jo);
        if (!(await type(a, P.jo.color, 'what if chat had no send button', my))) return;
        await gate.wait(600);
        if (my !== token) return;
        await commit(a, 'jo', 'what if chat had no send button');
        await gate.wait(500);
        const b = liveRow(P.maya);
        if (!(await type(b, P.maya.color, 'wait. that’s actually good', my))) return;
        await gate.wait(600);
        if (my !== token) return;
        await commit(b, 'maya', 'wait. that’s actually good');
        await gate.wait(2200);
        if (my !== token) return;
        reset(BASE);
      }
    },
    // 03 — everyone leaves, the room dissolves
    async (my) => {
      while (my === token) {
        reset([...BASE, ['jo', 'what if chat had no send button'], ['maya', 'wait. that’s actually good'], ['kofi', 'goodnight, both ✨']]);
        setPeople(['jo', 'maya', 'kofi']);
        await gate.wait(1200);
        for (const keys of [['jo', 'maya'], ['jo'], []]) {
          if (my !== token) return;
          setPeople(keys);
          await gate.wait(600);
        }
        [...linesEl.children].reverse().forEach((m, i) => {
          m.style.setProperty('--n', i);
          m.classList.add('is-dissolving');
        });
        await gate.wait(1700);
        if (my !== token) return;
        device.classList.add('is-empty');
        await gate.wait(2600);
      }
    },
  ];

  function setStep(i) {
    if (i === state) return;
    state = i;
    steps.forEach((s, k) => s.classList.toggle('is-active', k === i));
    const my = ++token;
    if (motion) scenes[i](my);
    else reset(BASE);
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) setStep(Number(e.target.dataset.step));
    },
    { rootMargin: '-45% 0px -45% 0px' }
  );
  steps.forEach((s) => io.observe(s));
  setStep(0);
}

// --------------------------------------------------------------- features

function initFeatures() {
  // Ciphertext keeps churning; the plaintext row "decrypts" on hover.
  const cipher = $('[data-cipher]');
  const plain = $('[data-plain]');
  if (cipher) {
    const HEX = '0123456789abcdef';
    const gate = whileVisible(cipher);
    const groups = () => Array.from({ length: 7 }, () => Array.from({ length: 4 }, () => pick(HEX)).join('')).join('·');
    (async () => {
      for (;;) {
        await gate.wait(motion ? 110 : 5000);
        cipher.textContent = groups();
      }
    })();
    const finalText = plain.textContent;
    const decrypt = async () => {
      const GLYPHS = 'abcdefghijklmnopqrstuvwxyz0123456789#%&';
      for (let f = 0; f <= 18; f++) {
        plain.textContent = [...finalText].map((ch, i) => (ch === ' ' || i < (f / 18) * finalText.length ? ch : pick(GLYPHS))).join('');
        await sleep(32);
      }
      plain.textContent = finalText;
    };
    if (motion) {
      plain.closest('.card').addEventListener('pointerenter', decrypt);
      new IntersectionObserver(([e], o) => e.isIntersecting && (decrypt(), o.disconnect())).observe(plain);
    }
  }

  // Identity: names and colours trade places.
  const tag = $('[data-id-tag]');
  const swatches = $('[data-id-swatches]');
  const idName = $('[data-id-name]');
  const idAvatar = $('[data-id-avatar]');
  swatches.append(...COLORS.map((c) => h('i', { style: { '--c': c.value } })));
  let ci = 0;
  const swap = () => {
    ci = (ci + 1 + Math.floor(Math.random() * 3)) % COLORS.length;
    const name = randomName();
    idName.textContent = name;
    idAvatar.textContent = name.split(' ').map((w) => w[0]).join('');
    idAvatar.style.setProperty('--c', COLORS[ci].value);
    [...swatches.children].forEach((s, i) => s.classList.toggle('is-on', i === ci));
    tag.classList.remove('is-swap');
    void tag.offsetWidth;
    tag.classList.add('is-swap');
  };
  swap();
  if (motion) {
    const gate = whileVisible(tag);
    (async () => {
      for (;;) {
        await gate.wait(2200);
        swap();
      }
    })();
  }

  // Reactions pile up.
  const chips = $('[data-react-chips]');
  if (motion) {
    const gate = whileVisible(chips);
    (async () => {
      for (;;) {
        chips.replaceChildren();
        await gate.wait(900);
        const counts = {};
        for (const emoji of ['🔥', '🔥', '👀', '🔥', '❤️', '👀']) {
          counts[emoji] = (counts[emoji] || 0) + 1;
          let chip = $(`[data-e="${emoji}"]`, chips);
          if (!chip) chips.append((chip = h('span.rx', { dataset: { e: emoji } }, h('span', emoji), h('span', '1'))));
          else {
            chip.lastChild.textContent = counts[emoji];
            chip.classList.remove('is-pop');
            void chip.offsetWidth;
            chip.classList.add('is-pop');
          }
          await gate.wait(rand(450, 800));
        }
        await gate.wait(2600);
      }
    })();
  } else chips.append(h('span.rx', h('span', '🔥'), h('span', '3')));

  // Keycaps follow the real keyboard.
  const caps = new Map($$('[data-key]').map((k) => [k.dataset.key.toLowerCase(), k]));
  document.addEventListener('keydown', (e) => caps.get(e.key.toLowerCase())?.classList.add('is-down'));
  document.addEventListener('keyup', (e) => caps.get(e.key.toLowerCase())?.classList.remove('is-down'));
  addEventListener('blur', () => caps.forEach((k) => k.classList.remove('is-down')));

  // Same letters, two screens, same moment.
  const a = $('[data-sync="a"]');
  const b = $('[data-sync="b"]');
  if (a && motion) {
    const gate = whileVisible(a);
    const phrases = ['on my way — 5 min', 'did you see that?!', 'okay one more idea…'];
    (async () => {
      for (let i = 0; ; i = (i + 1) % phrases.length) {
        for (const ch of [...phrases[i]]) {
          a.append(freshSpan(ch, '#ffbe3d'));
          setTimeout(() => b.append(freshSpan(ch, '#ffbe3d')), 40);
          await gate.wait(ch === ' ' ? 120 : rand(50, 110));
        }
        await gate.wait(1800);
        a.replaceChildren();
        b.replaceChildren();
        await gate.wait(500);
      }
    })();
  } else if (a) {
    a.textContent = b.textContent = 'on my way — 5 min';
  }
}

// ------------------------------------------------------------------ rooms

function initRooms() {
  const grid = $('[data-room-grid]');
  const search = $('[data-room-search]');
  const cards = new Map();
  let rooms = [];
  let createCard;
  let empty;

  const badge = (room) =>
    room.people
      ? h('span.live-badge.is-live', h('span.dot-live'), `${room.people} here`)
      : h('span.live-badge', h('span.hollow'), 'quiet');

  const foot = (room) =>
    h(
      'div.room-foot',
      room.members?.length
        ? h('span.avatar-stack', room.members.slice(0, 4).map((m, i) => Object.assign(avatar(m, 'sm'), { style: `--c:${m.color};--i:${i}` })))
        : h('span.room-empty-note', 'Be the first one here'),
      h('span.room-join', h('span.label', 'Join'), h('span', { html: arrowIcon }))
    );

  function build(room, i) {
    const card = h(
      'a.room-card',
      { href: roomHref(room.id), 'data-spotlight': true, style: { '--i': i % 6 } },
      h('div.room-top', badge(room), h('span.room-when', room.people ? 'live now' : `active ${timeAgo(room.lastActivity)}`)),
      h('h3.room-name', room.name),
      h('p.room-topic', room.topic || 'No topic — just vibes.'),
      foot(room)
    );
    card.dataset.sig = sig(room);
    card.addEventListener('animationend', () => card.classList.add('is-settled'), { once: true });
    return card;
  }
  const sig = (room) => `${room.people}|${(room.members || []).map((m) => m.name + m.color).join(',')}`;

  function update(card, room) {
    if (card.dataset.sig !== sig(room)) {
      card.querySelector('.live-badge').replaceWith(badge(room));
      card.querySelector('.room-foot').replaceWith(foot(room));
      card.dataset.sig = sig(room);
    }
    card.querySelector('.room-when').textContent = room.people ? 'live now' : `active ${timeAgo(room.lastActivity)}`;
  }

  function render() {
    grid.setAttribute('aria-busy', 'false');
    $$('.skeleton', grid).forEach((s) => s.remove());
    empty?.remove();
    empty = null;
    const seen = new Set();
    rooms.forEach((room, i) => {
      seen.add(room.id);
      let card = cards.get(room.id);
      if (card) update(card, room);
      else cards.set(room.id, (card = build(room, i)));
      if (grid.children[i] !== card) grid.insertBefore(card, grid.children[i] || null);
    });
    for (const [id, card] of cards) {
      if (!seen.has(id)) {
        card.remove();
        cards.delete(id);
      }
    }
    createCard ||= h(
      'button.room-card.room-card--new',
      { type: 'button', onclick: (e) => openCreateRoom(e.currentTarget), onanimationend: (e) => e.currentTarget.classList.add('is-settled') },
      h('span.plus', { html: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg>' }),
      h('strong', 'Start your own'),
      h('span', 'Public or link-only. Takes five seconds.')
    );
    if (grid.lastElementChild !== createCard) grid.append(createCard);
    filter();
  }

  function filter() {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const room of rooms) {
      const match = !q || `${room.name} ${room.topic}`.toLowerCase().includes(q);
      cards.get(room.id).hidden = !match;
      if (match) shown++;
    }
    empty?.remove();
    empty = null;
    if (q && !shown) {
      const name = search.value.trim();
      empty = h(
        'div.rooms-empty',
        h('p', 'No rooms match ', h('strong', `“${name}”`), '.'),
        h('button.btn.btn-secondary.btn-sm', { type: 'button', onclick: (e) => openCreateRoom(e.currentTarget, { name }) }, h('span.btn-label', `Create “${name.slice(0, 24)}”`))
      );
      grid.prepend(empty);
    }
    if (createCard) createCard.hidden = Boolean(q && shown);
  }

  search.addEventListener('input', filter);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = '';
      filter();
      search.blur();
    }
    if (e.key === 'Enter') {
      const first = rooms.find((r) => !cards.get(r.id).hidden);
      if (first) location.href = roomHref(first.id);
    }
  });

  onRooms((next) => {
    rooms = next;
    render();
  });
}

// -------------------------------------------------------------------- faq

function initFaq() {
  const items = $$('.faq-item');
  for (const item of items) {
    const btn = $('button', item);
    btn.addEventListener('click', () => {
      const open = !item.classList.contains('is-open');
      for (const other of items) {
        other.classList.remove('is-open');
        $('button', other).setAttribute('aria-expanded', 'false');
      }
      item.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', String(open));
    });
  }
}

// ------------------------------------------------------------- final CTA

function initStart() {
  const form = $('[data-start-form]');
  const input = $('[data-start-input]');
  const mirror = $('[data-start-mirror]');
  const submit = $('[data-start-submit]');
  const privacy = $('[data-start-private]');
  let prev = [];

  // The input's own text is invisible; the mirror renders it with fresh-letter highlights.
  const sync = () => {
    const next = [...input.value];
    const { start, removed, inserted } = diffChars(prev, next);
    const spans = [...mirror.children];
    spans.slice(start, start + removed).forEach((s) => s.remove());
    const anchor = spans[start + removed] || null;
    for (const ch of inserted) mirror.insertBefore(motion ? freshSpan(ch, '#d7ff3a') : h('span', ch), anchor);
    prev = next;
    mirror.scrollLeft = input.scrollLeft;
  };
  input.addEventListener('input', sync);
  input.addEventListener('scroll', () => (mirror.scrollLeft = input.scrollLeft));
  input.addEventListener('keyup', () => (mirror.scrollLeft = input.scrollLeft));

  privacy.addEventListener('click', () => privacy.setAttribute('aria-checked', String(privacy.getAttribute('aria-checked') !== 'true')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) {
      form.classList.remove('has-error');
      void form.offsetWidth;
      form.classList.add('has-error');
      input.focus();
      return;
    }
    submit.disabled = true;
    submit.classList.add('is-loading');
    try {
      const room = await createAndEnter({ name, isPublic: privacy.getAttribute('aria-checked') !== 'true' });
      location.href = roomHref(room.id, { secret: room.isPublic === false });
    } catch (err) {
      submit.disabled = false;
      submit.classList.remove('is-loading');
      openCreateRoom(submit, { name });
    }
  });
}

// ----------------------------------------------------------------- footer

async function initFooter() {
  $('[data-year]').textContent = new Date().getFullYear();

  const word = $('[data-footer-word]');
  const letters = [...word.textContent].map((ch) => h('span', ch));
  word.replaceChildren(...letters, h('span.word-caret'));
  if (motion && !isTouch()) {
    word.addEventListener('pointermove', (e) => {
      for (const l of letters) {
        const r = l.getBoundingClientRect();
        const d = Math.abs(e.clientX - (r.left + r.width / 2));
        l.style.setProperty('--lift', `${-Math.max(0, 1 - d / 160) * 0.12 * r.height}px`);
      }
    });
    word.addEventListener('pointerleave', () => letters.forEach((l) => l.style.setProperty('--lift', '0px')));
  }

  const status = $('.footer-status');
  const text = $('[data-status-text]');
  const mode = await getMode();
  if (mode === 'server') {
    status.classList.add('is-live');
    text.textContent = 'Live server connected';
  } else if (mode === 'relay') {
    let shown = false;
    onRooms(() => {
      if (shown) return;
      shown = true;
      status.classList.add('is-live');
      text.textContent = 'Connected · end-to-end encrypted relay';
    });
  } else {
    status.classList.add('is-down');
    text.textContent = 'Offline mode — rooms sync across your tabs';
  }
}

// -------------------------------------------------------------- shortcuts

function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    if (document.activeElement?.closest('input, textarea, [contenteditable="true"]') || $('.modal:not([hidden])')) return;
    if (e.key === '/') {
      e.preventDefault();
      const search = $('[data-room-search]');
      search.scrollIntoView({ behavior: motion ? 'smooth' : 'auto', block: 'center' });
      search.focus({ preventScroll: true });
    } else if (e.key === 'c' || e.key === 'C') {
      openCreateRoom($('.nav-cta'));
    } else if (e.key === 'j' || e.key === 'J') {
      location.href = roomHref('lobby');
    }
  });
}
