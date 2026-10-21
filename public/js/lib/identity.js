import { session, store } from './util.js';

export const COLORS = [
  { name: 'Scarlet', value: '#ff3932' },
  { name: 'Ember', value: '#ff8a3d' },
  { name: 'Sun', value: '#f5c542' },
  { name: 'Lime', value: '#9be15d' },
  { name: 'Mint', value: '#34d399' },
  { name: 'Sky', value: '#38bdf8' },
  { name: 'Iris', value: '#8b7bff' },
  { name: 'Rose', value: '#f472b6' },
];

const ADJECTIVES = ['Quiet', 'Amber', 'Lunar', 'Swift', 'Velvet', 'Cosmic', 'Brave', 'Misty', 'Golden', 'Gentle', 'Wild', 'Neon', 'Silver', 'Sunny', 'Sleepy', 'Clever'];
const ANIMALS = ['Otter', 'Falcon', 'Fox', 'Koala', 'Heron', 'Lynx', 'Panda', 'Moth', 'Badger', 'Tiger', 'Wren', 'Orca', 'Gecko', 'Raven', 'Bison', 'Hare'];
const ROOM_WORDS = [['quiet', 'amber', 'lunar', 'swift', 'velvet', 'cosmic', 'misty', 'golden', 'neon', 'silver'], ['otter', 'harbor', 'falcon', 'meadow', 'lantern', 'orbit', 'maple', 'river', 'ember', 'nova']];

const rand = (list) => list[Math.floor(Math.random() * list.length)];

export const randomName = () => `${rand(ADJECTIVES)} ${rand(ANIMALS)}`;
export const randomColor = () => rand(COLORS).value;
export const uid = (n = 12) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => (b % 36).toString(36)).join('');
export const roomSlug = () => `${rand(ROOM_WORDS[0])}-${rand(ROOM_WORDS[1])}-${uid(3)}`;

/** One id per browser tab, so two tabs are two people (handy for testing). */
export function tabId() {
  let id = session.get('midsentence:tab');
  if (!id) {
    id = uid(12);
    session.set('midsentence:tab', id);
  }
  return id;
}

export function getProfile() {
  const saved = store.get('midsentence:profile');
  return {
    name: saved?.name || randomName(),
    color: COLORS.some((c) => c.value === saved?.color) ? saved.color : randomColor(),
    saved: Boolean(saved?.name),
  };
}

export function saveProfile({ name, color }) {
  store.set('midsentence:profile', { name, color });
}
