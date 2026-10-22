# Midsentence

**Say it as you think it.** Midsentence is a chat room without a send button. Everyone in a room sees your words *as you type them*: the pauses, the edits, the half-finished thought. <kbd>Enter</kbd> tucks the line into the conversation and clears the stage for your next one.

It runs anywhere, including as plain static files on Vercel, with no accounts and no API keys.

## Features

- **Live keystrokes.** Letters land with a marker highlight in the typist's colour, and a caret shows exactly where each person is editing.
- **Rooms in one click.** Name a room and share the link. Public rooms are listed on the homepage; link-only rooms aren't listed anywhere.
- **End-to-end encryption in relay mode.** In link-only rooms, every keystroke is encrypted in the browser with a key derived from the room link, so the relay only ever sees ciphertext.
- **Presence.** See who's typing, who has a draft hanging and who stepped away. Leaving announces itself, even if a tab crashes.
- **Transcript.** Lines are grouped by author, anyone can add emoji reactions, and late joiners catch up on recent history.
- **Keyboard-first.** <kbd>Enter</kbd> commits a line, <kbd>Esc</kbd> clears your draft, <kbd>↑</kbd> brings back your last line, <kbd>/</kbd> focuses the input, and typing anywhere on the room page starts a message. On the homepage, <kbd>C</kbd> creates a room and <kbd>J</kbd> joins the Lobby.
- **Light and dark themes.** It follows the OS setting, and the toggle wipes the new theme in as a circle from the button (View Transitions).
- **Ephemeral.** Only recent history is kept while a room is in use, and it's cleared shortly after the last person leaves.

## How realtime works

The client picks a backend automatically:

| Mode | When | How |
| --- | --- | --- |
| **Server** | `/api/health` answers (you ran `npm start`, or set `<meta name="midsentence-server">`) | WebSocket to the bundled Node server (`server/`) |
| **Relay** | Static hosting (Vercel, Netlify, GitHub Pages…) | Browsers talk through public MQTT-over-WebSocket brokers (EMQX and HiveMQ by default), connected in parallel and de-duplicated. Room traffic is AES-GCM encrypted with a key derived from the room id (PBKDF2), and broker topics are derived from that key too, so they reveal nothing about the room. |
| **Local** | Relay disabled with `<meta name="midsentence-relay" content="off">` | `BroadcastChannel`, which only syncs tabs of one browser |

Link-only rooms get a long random id, which doubles as the encryption key. Their links carry it in the URL fragment (`room.html#…`), so it never reaches the web host's logs. Presence, recent history (shared by the longest-present member) and the public room directory all travel through the same relay.

The default relays are free public brokers. They work well for personal projects and demos, but nobody guarantees their uptime. For something serious, point `<meta name="midsentence-relay">` at your own broker, such as a free-tier EMQX Cloud or HiveMQ Cloud instance. List several URLs separated by commas.

## Quick start

```bash
npm install
npm start          # → http://localhost:3000 (server mode)
npm test           # server + relay protocol tests
```

To try relay mode locally, serve the static files, for example with `npx serve public`, and open the same room in two browsers.

## Deploying to Vercel

Import the repository at [vercel.com/new](https://vercel.com/new) and click **Deploy**. The included `vercel.json` serves `public/` with no build step, so no settings are needed. On Vercel the app runs in relay mode and is fully multi-user. Every push to `main` redeploys.

## Project layout

```
public/              static client (no build step, plain ES modules)
  index.html         landing page
  room.html          lobby + live room
  404.html
  css/base.css       design tokens (light + dark) and shared components
  css/landing.css    landing page
  css/room.css       room UI
  js/landing.js      landing: letter field, interactive demo, scroll story, live rooms
  js/room.js         room: stage, transcript, presence, reactions
  js/lib/api.js      mode detection + rooms API (server / relay / local)
  js/lib/transport.js  room connection (WebSocket, relay or local)
  js/lib/relay.js    relay hub, encryption, presence, history, directory
  js/lib/mqtt.js     tiny dependency-free MQTT 3.1.1 client over WebSocket
server/              Node server for server mode (http + ws)
test/                node:test suites (server protocol, relay protocol over a local broker)
vercel.json          static hosting config
```

## Accessibility

The app uses semantic landmarks, visible focus rings and focus-trapped dialogs, and every control is reachable by keyboard. The transcript is an ARIA live log. The keystroke stage is hidden from screen readers so they aren't flooded, and the people list shows who is typing instead. `prefers-reduced-motion` turns off non-essential animation.
