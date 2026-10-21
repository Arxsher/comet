# Midsentence

**Chat in real time, letter by letter.** Midsentence is a chat room with no send button: everyone in the room sees what you type *as you type it*, including typos and backspaces. Pressing <kbd>Enter</kbd> moves your line into the transcript and clears the stage for your next thought.

## Features

- **Live keystrokes.** Letters stream over WebSockets. Fresh letters arrive glowing in the typist's color and fade to white, and each person's caret shows exactly where they are editing.
- **Rooms in one click.** Name a room, choose public (listed on the homepage) or link-only, and share the link. No accounts.
- **Presence.** See who's here, who's typing, who has a draft open, and who stepped away.
- **Transcript.** Lines are grouped by author, and anyone can add emoji reactions.
- **Keyboard-first.** <kbd>Enter</kbd> commits a line, <kbd>Esc</kbd> clears your draft, <kbd>↑</kbd> brings back your last line, <kbd>/</kbd> focuses the input, and typing anywhere on the room page starts a message. On the homepage, <kbd>C</kbd> creates a room and <kbd>J</kbd> joins the Lobby.
- **Ephemeral.** Rooms live in memory only. A room is cleared about 10 minutes after the last person leaves.
- **Resilient.** The client reconnects with backoff and keeps your seat. Lines you commit while offline are queued and sent when you're back.
- **Works without a server.** On a static host, Midsentence switches to *local mode*, where rooms sync between tabs of the same browser through `BroadcastChannel`.

## Quick start

```bash
npm install
npm start          # → http://localhost:3000
```

Open the same room in two browser windows (or on your phone) and start typing.

| Script        | What it does                                   |
| ------------- | ---------------------------------------------- |
| `npm start`   | Runs the server (`PORT` env var, default 3000) |
| `npm run dev` | Same, restarting on server file changes        |
| `npm test`    | Runs the API and WebSocket protocol tests      |

Requires Node 18.17+. The only runtime dependency is [`ws`](https://github.com/websockets/ws).

## Project layout

```
public/              static client (no build step, plain ES modules)
  index.html         landing page
  room.html          lobby + live room
  css/base.css       design tokens and shared components
  css/landing.css    landing page
  css/room.css       room UI
  js/landing.js      landing interactions + simulated live demo
  js/room.js         the room: stage, transcript, presence, reactions
  js/lib/            api, transport (WebSocket + local mode), ui, utils
server/
  index.js           HTTP (static files + JSON API) and WebSocket server
  rooms.js           in-memory room store
test/                node:test suite for the API and socket protocol
```

## Deploying

- **Full experience (multi-user):** deploy as a Node app on any host that supports long-lived WebSockets (Render, Railway, Fly.io, a VPS…) with `npm start`.
- **Static only:** serve the `public/` folder from any static host (Vercel, Netlify, GitHub Pages). The app runs in local mode, so rooms only sync between tabs of one browser. On Vercel, the included `vercel.json` already serves `public/`, so you can import the repo without changing any settings. On Netlify, set the publish directory to `public`.
- **Split hosting:** host `public/` statically and run the server elsewhere. Put the server's origin in the `<meta name="midsentence-server">` tag in `index.html` and `room.html`. The API sends CORS headers.

## Protocol

The client sends JSON messages over `/ws`:

| Client → server                         | Server → client                                   |
| --------------------------------------- | ------------------------------------------------- |
| `join { room, me: { id, name, color } }` | `welcome { you, room, members, lines }`           |
| `type { text, caret }`                  | `join { member }` / `leave { id }`                |
| `commit { text, nonce }`                | `type { id, text, caret }`                        |
| `react { line, emoji }`                 | `line { line, nonce }`                            |
| `profile { name, color }`               | `react { line, reactions }`                       |
| `away { away }` / `leave`               | `profile { member }` / `error { code, message }`  |

REST endpoints: `GET /api/health`, `GET /api/stats`, `GET /api/rooms`, `POST /api/rooms`, and `GET /api/rooms/:id`. `/r/:id` redirects to the room page.

Limits: 500 characters per line, 50 people per room, the last 300 lines per room, and about 60 messages per second per connection.

## Accessibility

The app uses semantic landmarks, visible focus rings, and focus-trapped dialogs, and every control is reachable by keyboard. The transcript is an ARIA live log. The keystroke stage is hidden from screen readers so they aren't flooded. The people list shows who is typing instead. `prefers-reduced-motion` turns off non-essential animation.
