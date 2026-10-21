import { $, $$, h, avatar, clamp, sleep, reducedMotion, isTouch, timeAgo, plural } from './lib/util.js';
import { getMode, getStats, listRooms, roomHref } from './lib/api.js';
import { openCreateRoom, initSpotlight, initMagnetic, initReveal, initRipples, toast } from './lib/ui.js';

const motion = !reducedMotion();

initBackground();
initNav();
initHero();
initPreview();
initMarquee();
initFeatures();
initSteps();
initRooms();
initFaq();
initShortcuts();
initFooter();
initSpotlight();
initMagnetic();
initReveal();
initRipples();

for (const btn of $$('[data-create-room]')) btn.addEventListener('click', () => openCreateRoom(btn));

// ------------------------------------------------------------- background

function initBackground() {
  const bg = $('.bg');
  const lit = $('.bg-dots-lit');
  if (!lit || isTouch() || !motion) return;
  let frame = 0;
  let x = 0;
  let y = 0;
  window.addEventListener(
    'pointermove',
    (e) => {
      x = e.clientX;
      y = e.clientY;
      bg.classList.add('is-tracking');
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        lit.style.setProperty('--cx', `${x}px`);
        lit.style.setProperty('--cy', `${y}px`);
      });
    },
    { passive: true }
  );
  document.addEventListener('pointerleave', () => bg.classList.remove('is-tracking'));
}

// -------------------------------------------------------------------- nav

function initNav() {
  const nav = $('[data-nav]');
  const links = $('[data-nav-links]');
  const hover = $('.nav-hover', links);
  const burger = $('[data-burger]');
  const menu = $('[data-mobile-menu]');

  // Sliding hover pill
  for (const a of $$('a', links)) {
    a.addEventListener('pointerenter', () => {
      links.style.setProperty('--x', `${a.offsetLeft}px`);
      links.style.setProperty('--w', `${a.offsetWidth}px`);
      links.classList.add('is-hovering');
      requestAnimationFrame(() => links.classList.add('was-hovering'));
    });
  }
  links.addEventListener('pointerleave', () => links.classList.remove('is-hovering', 'was-hovering'));

  // Compact + hide on scroll down, show on scroll up
  let lastY = scrollY;
  let ticking = false;
  window.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const y = scrollY;
        nav.classList.toggle('is-scrolled', y > 24);
        if (!menu.classList.contains('is-open')) {
          if (y > 520 && y - lastY > 6) nav.classList.add('is-hidden');
          else if (lastY - y > 6 || y < 520) nav.classList.remove('is-hidden');
        }
        lastY = y;
      });
    },
    { passive: true }
  );

  // Scroll spy
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

  // Mobile menu
  $$('li', menu).forEach((li, i) => li.style.setProperty('--i', i));
  const setMenu = (open) => {
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    if (open) {
      menu.hidden = false;
      requestAnimationFrame(() => menu.classList.add('is-open'));
      nav.classList.remove('is-hidden');
    } else {
      menu.classList.remove('is-open');
      setTimeout(() => {
        if (!menu.classList.contains('is-open')) menu.hidden = true;
      }, 300);
    }
  };
  burger.addEventListener('click', () => setMenu(burger.getAttribute('aria-expanded') !== 'true'));
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) setMenu(false);
  });
  document.addEventListener('click', (e) => {
    if (menu.classList.contains('is-open') && !nav.contains(e.target)) setMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('is-open')) {
      setMenu(false);
      burger.focus();
    }
  });
  matchMedia('(min-width: 821px)').addEventListener('change', (e) => e.matches && setMenu(false));
}

// ------------------------------------------------------------------- hero

function initHero() {
  const liveWord = $('[data-live-word]');
  const liveText = $('.live-text', liveWord);
  const liveCaret = $('.live-caret', liveWord);
  const sub = $('[data-typewriter]');

  // Split "live" and the subtitle into letters we can switch on one by one.
  liveText.innerHTML = '';
  const liveLetters = [...'live'].map((c) => liveText.appendChild(h('span', c)));
  const full = sub.dataset.typewriter;
  sub.textContent = '';
  const chars = [...full].map((c) => sub.appendChild(h('span.ch', c)));

  if (!motion) {
    liveLetters.forEach((l) => l.classList.add('is-on'));
    chars.forEach((c) => c.classList.add('is-on'));
    liveCaret.style.display = 'none';
  } else (async () => {
    await sleep(620);
    for (const letter of liveLetters) {
      letter.classList.add('is-on');
      await sleep(110 + Math.random() * 60);
    }
    await sleep(520);
    // The caret hops from "live" down to the subtitle and keeps typing.
    liveCaret.style.visibility = 'hidden';
    let prev;
    for (let i = 0; i < chars.length; i++) {
      prev?.classList.remove('is-cursor');
      chars[i].classList.add('is-on', 'is-cursor');
      prev = chars[i];
      const ch = full[i];
      await sleep(ch === '.' ? 260 : ch === ' ' ? 34 : 16 + Math.random() * 22);
    }
  })();

  // Live stats in the hero badge
  const count = $('[data-hero-count]');
  const stack = $('[data-hero-avatars]');
  const refresh = async () => {
    try {
      const [stats, rooms] = await Promise.all([getStats(), listRooms()]);
      const people = rooms.flatMap((r) => r.members || []);
      const text = stats.people
        ? `${plural(stats.people, 'person', 'people')} chatting in ${plural(stats.liveRooms, 'room')} right now`
        : `${plural(stats.rooms, 'open room')} — be the first one in`;
      if (count.textContent !== text) {
        count.textContent = text;
        count.classList.remove('count-flip');
        void count.offsetWidth;
        count.classList.add('count-flip');
      }
      if (people.length) {
        stack.replaceChildren(...people.slice(0, 3).map((m, i) => Object.assign(avatar(m, 'sm'), { style: `--c:${m.color};--i:${i}` })));
      }
    } catch {}
  };
  refresh();
  setInterval(() => document.visibilityState === 'visible' && refresh(), 10000);

  $('[data-start-chatting]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('is-loading');
    try {
      const rooms = await listRooms();
      const busiest = rooms.find((r) => r.people > 0);
      location.href = roomHref(busiest?.id || 'lobby');
    } catch {
      location.href = roomHref('lobby');
    }
  });
}

// -------------------------------------------------------- preview (demo)

function initPreview() {
  const preview = $('[data-preview]');
  const win = $('.preview-window', preview);
  const transcript = $('[data-demo-transcript]');
  const stage = $('[data-demo-stage]');
  const input = $('[data-demo-input]');
  const placeholder = $('[data-demo-placeholder]');
  const composer = $('.preview-composer');
  const enter = $('.preview-enter');
  const peopleList = $('[data-demo-people]');
  for (const el of $$('[data-host]')) el.textContent = location.host || 'comet';

  const PEOPLE = {
    maya: { name: 'Maya', color: '#f472b6' },
    leo: { name: 'Leo', color: '#38bdf8' },
    ana: { name: 'Ana', color: '#f5c542' },
    you: { name: 'You', color: '#ff3932' },
  };

  const SCRIPT = [
    { who: 'maya', text: 'okay who else is still up', after: 'end', delay: 400 },
    { who: 'leo', text: 'me. debugging something cursed', after: 'start', delay: 1500, typo: { at: 22, wrong: 'hti' } },
    { who: 'ana', text: 'wait, you can see me typing??', after: 'end', delay: 300, typo: { at: 21, wrong: 'yp' } },
    { who: 'maya', text: 'every single letter 👀', after: 'start', delay: 1700 },
    { who: 'leo', text: 'no more rewriting my hot takes in secret', after: 'end', delay: 500 },
    { who: 'you', text: 'honestly this feels like actually talking', after: 'start', delay: 900 },
    { who: 'ana', text: 'ok this is kind of addictive', after: 'end', delay: 400, typo: { at: 18, wrong: 'f ' } },
  ];

  // People sidebar
  const rows = {};
  for (const [key, p] of Object.entries(PEOPLE)) {
    const state = h('small', key === 'you' ? 'you' : 'here');
    rows[key] = { li: h('li', avatar(p, 'sm'), h('span', p.name), state), state };
    peopleList.append(rows[key].li);
  }
  const setTyping = (key, on) => {
    const row = rows[key];
    row.li.classList.toggle('is-typing', on);
    const dots = h('span.typing-dots', { style: { '--c': PEOPLE[key].color } }, h('i'), h('i'), h('i'));
    row.state.replaceWith((row.state = on ? dots : h('small', key === 'you' ? 'you' : 'here')));
  };

  // Pause while off-screen or in a background tab.
  let visible = false;
  const waiters = [];
  const running = () => visible && document.visibilityState === 'visible';
  const flush = () => running() && waiters.splice(0).forEach((r) => r());
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    flush();
  }).observe(preview);
  document.addEventListener('visibilitychange', flush);
  const wait = async (ms) => {
    await sleep(ms);
    while (!running()) await new Promise((r) => waiters.push(r));
  };
  const rand = (a, b) => a + Math.random() * (b - a);
  const pace = (ch) => (/[.,?!]/.test(ch) ? rand(180, 320) : ch === ' ' ? rand(70, 140) : rand(40, 105));

  function liveTarget(key) {
    const p = PEOPLE[key];
    if (key === 'you') {
      return {
        set(text, added) {
          placeholder.style.opacity = text ? '0' : '1';
          composer.classList.toggle('is-active', Boolean(text));
          if (added) input.append(h('span.hot', { style: { '--c': p.color } }, added));
          else input.lastChild?.remove();
        },
        async commit() {
          enter.classList.add('is-pressed');
          await sleep(140);
          enter.classList.remove('is-pressed');
          input.textContent = '';
          placeholder.style.opacity = '1';
          composer.classList.remove('is-active');
        },
      };
    }
    const what = h('span.what');
    const row = h('div.demo-live', { style: { '--c': p.color } }, avatar(p, 'sm'), h('span.who', p.name), h('span.what-wrap', what, h('span.caret', { style: { '--c': p.color } })));
    stage.append(row);
    return {
      set(text, added) {
        if (added) what.append(h('span.hot', { style: { '--c': p.color } }, added));
        else what.lastChild?.remove();
      },
      async commit() {
        row.classList.add('is-leaving');
        await sleep(380);
        row.remove();
      },
    };
  }

  function postMessage(key, text) {
    const p = PEOPLE[key];
    const msg = h('div.demo-msg', { style: { '--c': p.color } }, avatar(p, 'sm'), h('div', h('b', p.name), h('p', text)));
    transcript.append(msg);
    while (transcript.children.length > 7) transcript.firstElementChild.remove();
  }

  async function typeLine({ who, text, typo }) {
    const target = liveTarget(who);
    setTyping(who, true);
    const letters = [...text];
    let current = '';
    for (let i = 0; i < letters.length; i++) {
      if (typo && i === typo.at) {
        for (const ch of typo.wrong) {
          current += ch;
          target.set(current, ch);
          await wait(rand(50, 110));
        }
        await wait(rand(280, 480));
        for (let k = 0; k < typo.wrong.length; k++) {
          current = current.slice(0, -1);
          target.set(current);
          await wait(rand(60, 90));
        }
      }
      current += letters[i];
      target.set(current, letters[i]);
      await wait(pace(letters[i]));
    }
    await wait(rand(450, 800));
    await target.commit();
    setTyping(who, false);
    postMessage(who, text);
  }

  async function loop() {
    for (;;) {
      await wait(600);
      let prevStart = Promise.resolve();
      let prevEnd = Promise.resolve();
      const all = [];
      for (const line of SCRIPT) {
        await (line.after === 'start' ? prevStart : prevEnd);
        await wait(line.delay);
        const done = typeLine(line);
        prevStart = Promise.resolve();
        prevEnd = done;
        all.push(done);
      }
      await Promise.all(all);
      await wait(3800);
      for (const msg of [...transcript.children]) {
        msg.classList.add('is-leaving');
        await sleep(70);
      }
      await wait(600);
      transcript.replaceChildren();
    }
  }

  if (motion) loop();
  else for (const line of SCRIPT) postMessage(line.who, line.text);

  // Tilt flattens as the window scrolls into place.
  if (motion) {
    let frame = 0;
    const update = () => {
      frame = 0;
      const r = preview.getBoundingClientRect();
      const t = clamp((r.top - innerHeight * 0.18) / (innerHeight * 0.62), 0, 1);
      preview.style.setProperty('--tilt', t.toFixed(3));
    };
    update();
    addEventListener('scroll', () => (frame ||= requestAnimationFrame(update)), { passive: true });
    addEventListener('resize', update);
  } else {
    preview.style.setProperty('--tilt', '0');
  }
  if (!isTouch()) {
    win.addEventListener('pointermove', (e) => {
      const r = win.getBoundingClientRect();
      win.style.setProperty('--mx', `${e.clientX - r.left}px`);
      win.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  }
}

// ---------------------------------------------------------------- marquee

function initMarquee() {
  const CITIES = [
    ['San Francisco', 'America/Los_Angeles'],
    ['Mexico City', 'America/Mexico_City'],
    ['New York', 'America/New_York'],
    ['São Paulo', 'America/Sao_Paulo'],
    ['London', 'Europe/London'],
    ['Casablanca', 'Africa/Casablanca'],
    ['Lagos', 'Africa/Lagos'],
    ['Berlin', 'Europe/Berlin'],
    ['Cairo', 'Africa/Cairo'],
    ['Istanbul', 'Europe/Istanbul'],
    ['Dubai', 'Asia/Dubai'],
    ['Mumbai', 'Asia/Kolkata'],
    ['Singapore', 'Asia/Singapore'],
    ['Seoul', 'Asia/Seoul'],
    ['Tokyo', 'Asia/Tokyo'],
    ['Sydney', 'Australia/Sydney'],
  ];
  const row = $('[data-cities]');
  const times = [];
  const make = (hidden) =>
    CITIES.map(([city, tz]) => {
      const time = h('time');
      times.push([time, tz]);
      return h('li', hidden ? { 'aria-hidden': 'true' } : null, city, time);
    });
  row.append(...make(false), ...make(true));
  const tick = () => {
    for (const [el, tz] of times) {
      try {
        el.textContent = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date());
      } catch {
        el.textContent = '';
      }
    }
  };
  tick();
  setInterval(tick, 20000);
}

// --------------------------------------------------------------- features

function initFeatures() {
  // Hot-letter typing loop
  const target = $('[data-hot-typing]');
  const phrases = ['hey, you around?', 'wait — I have an idea', 'typing this as I think it', 'no take-backs 😅'];
  if (!motion) target.textContent = phrases[0];
  else {
    let visible = false;
    new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(target);
    (async () => {
      for (let i = 0; ; i = (i + 1) % phrases.length) {
        while (!visible) await sleep(300);
        for (const ch of [...phrases[i]]) {
          target.append(h('span.hot', ch));
          await sleep(ch === ' ' ? 120 : 55 + Math.random() * 70);
        }
        await sleep(1800);
        while (target.lastChild) {
          target.lastChild.remove();
          await sleep(22);
        }
        await sleep(450);
      }
    })();
  }

  // Fake copy link
  const pill = $('[data-fake-copy]');
  let timer;
  pill?.addEventListener('click', () => {
    pill.classList.add('is-copied');
    clearTimeout(timer);
    timer = setTimeout(() => pill.classList.remove('is-copied'), 1400);
  });

  // Keycaps press along with the real keyboard
  const caps = new Map($$('[data-key]').map((k) => [k.dataset.key.toLowerCase(), k]));
  document.addEventListener('keydown', (e) => caps.get(e.key.toLowerCase())?.classList.add('is-down'));
  document.addEventListener('keyup', (e) => caps.get(e.key.toLowerCase())?.classList.remove('is-down'));
  window.addEventListener('blur', () => caps.forEach((k) => k.classList.remove('is-down')));
}

// ------------------------------------------------------------------ steps

function initSteps() {
  $$('.mini-stream span').forEach((s, i) => s.style.setProperty('--i', i));
  const wrap = $('[data-steps]');
  const fill = $('[data-step-fill]');
  const steps = $$('.step', wrap);
  let frame = 0;
  const update = () => {
    frame = 0;
    const r = wrap.getBoundingClientRect();
    const p = clamp((innerHeight * 0.7 - r.top) / (r.height * 0.9), 0, 1);
    fill.style.setProperty('--p', p.toFixed(3));
    steps.forEach((step, i) => step.classList.toggle('is-lit', p >= i / 2 - 0.02 && r.top < innerHeight * 0.8));
  };
  update();
  addEventListener('scroll', () => (frame ||= requestAnimationFrame(update)), { passive: true });
}

// ------------------------------------------------------------------ rooms

function initRooms() {
  const grid = $('[data-room-grid]');
  const search = $('[data-room-search]');
  const cards = new Map();
  let rooms = [];
  let createCard;
  let empty;

  const arrow = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h11M11 5l5 5-5 5"/></svg>';

  function badge(room) {
    return room.people
      ? h('span.live-badge.is-live', h('span.pulse-dot'), h('span.count-flip', `${room.people} live`))
      : h('span.live-badge', h('span.hollow'), 'quiet');
  }

  function foot(room) {
    const who = room.members?.length
      ? h('span.avatar-stack', room.members.slice(0, 4).map((m, i) => Object.assign(avatar(m, 'sm'), { style: `--c:${m.color};--i:${i}` })))
      : h('span.room-empty-note', 'Be the first one here');
    return h('div.room-foot', who, h('span.room-join', 'Join', h('span', { html: arrow })));
  }

  function build(room, i) {
    const card = h(
      'a.room-card',
      { href: roomHref(room.id), 'data-spotlight': true, style: { '--i': i } },
      h('div.room-top', badge(room), h('span.room-when', `active ${timeAgo(room.lastActivity)}`)),
      h('h3.room-name', room.name),
      h('p.room-topic', room.topic || 'No topic — just vibes.'),
      foot(room)
    );
    card.dataset.people = room.people;
    card.addEventListener('animationend', () => card.classList.add('is-settled'), { once: true });
    return card;
  }

  function update(card, room) {
    if (Number(card.dataset.people) !== room.people) {
      card.querySelector('.live-badge').replaceWith(badge(room));
      card.querySelector('.room-foot').replaceWith(foot(room));
      card.dataset.people = room.people;
    }
    card.querySelector('.room-when').textContent = `active ${timeAgo(room.lastActivity)}`;
  }

  function render() {
    grid.setAttribute('aria-busy', 'false');
    for (const sk of $$('.skeleton', grid)) sk.remove();
    empty?.remove();
    empty = null;
    const seen = new Set();
    rooms.forEach((room, i) => {
      seen.add(room.id);
      let card = cards.get(room.id);
      if (card) update(card, room);
      else cards.set(room.id, (card = build(room, i)));
      // Keep DOM order in sync without re-inserting cards that are already in place.
      const at = grid.children[i];
      if (at !== card) grid.insertBefore(card, at || null);
    });
    for (const [id, card] of cards) {
      if (!seen.has(id)) {
        card.remove();
        cards.delete(id);
      }
    }
    createCard ||= h(
      'button.room-card.room-card--new',
      {
        type: 'button',
        style: { '--i': rooms.length },
        onclick: (e) => openCreateRoom(e.currentTarget),
        onanimationend: (e) => e.currentTarget.classList.add('is-settled'),
      },
      h('span.plus', { html: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg>' }),
      h('strong', 'Start your own room'),
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
        h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: (e) => openCreateRoom(e.currentTarget, { name }) }, h('span.btn-label', `Create “${name.slice(0, 24)}”`))
      );
      grid.prepend(empty);
    }
    createCard && (createCard.hidden = Boolean(q && shown));
  }

  async function load() {
    try {
      rooms = await listRooms();
      render();
    } catch {
      if (!cards.size) {
        grid.setAttribute('aria-busy', 'false');
        grid.replaceChildren(h('div.rooms-empty', h('p', 'Couldn’t load rooms right now.'), h('button.btn.btn-ghost.btn-sm', { type: 'button', onclick: load }, h('span.btn-label', 'Try again'))));
      }
    }
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

  load();
  setInterval(() => document.visibilityState === 'visible' && load(), 10000);
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

// -------------------------------------------------------------- shortcuts

function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const el = document.activeElement;
    if (el?.closest('input, textarea, [contenteditable="true"]') || $('.modal:not([hidden])')) return;
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

// ----------------------------------------------------------------- footer

async function initFooter() {
  $('[data-year]').textContent = new Date().getFullYear();
  const status = $('.footer-status');
  const text = $('[data-status-text]');
  const mode = await getMode();
  status.classList.add(mode === 'server' ? 'is-server' : 'is-local');
  text.textContent = mode === 'server' ? 'Live server connected' : 'Local mode — rooms sync across your tabs';
  if (mode === 'local' && !sessionStorage.getItem('comet:local-noted')) {
    sessionStorage.setItem('comet:local-noted', '1');
    setTimeout(() => toast('No Comet server found — running in local mode (rooms sync across tabs).', { icon: 'ℹ', duration: 5200 }), 2600);
  }
}
