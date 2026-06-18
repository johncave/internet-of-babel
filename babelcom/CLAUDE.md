# Babelcom

Babelcom is an **art piece**, not a real admin tool. It's a fake retro Windows-95/98-vaporwave desktop, rendered in the browser, that pretends to be the monitoring console for a doomed [Intel Compute Stick](https://en.wikipedia.org/wiki/Intel_Compute_Stick) that writes encyclopedia articles until the heat death of the universe.

The comedy-and-existential-dread tone is **load-bearing**. It shows up deliberately throughout the code — Clippy's LLM prompt, the boot sequence, the canned phrases, the Welcome app ("Babelcorp Employee #419"). Treat it as a feature, not as noise to "clean up." When you add copy, match the register: confidently useless, mundane, quietly doomed.

Babelcom is one component of the `babelcorp` monorepo and is served on `babelcom.*` hostnames. The other components are `librarian` (the public encyclopedia, on `wiki.*`/`web4`) and `worker` (the actual article-generating process that runs on the physical machine and pushes updates into Babelcom).

---

## ⚠️ The one thing to get straight first: there are TWO Clippys

This trips people up. They are different programs with the same name and personality.

| | **Backend Clippy** | **Frontend Clippy** |
|---|---|---|
| File | [clippy.go](clippy.go) | [static/app.js](static/app.js) (`Clippy` IIFE) |
| Runtime | Go, server-side | Browser, client-side |
| What it is | An LLM agent (Ollama) | The animated clippyjs sprite |
| Job | Read the article token stream, decide *what* Clippy says | Animate, point, and render *what was said* |
| Output | Broadcasts `clippy_comment` / `clippy_existential` messages | Listens for those messages, plays the choreography |

They communicate **only** through the WebSocket bus (`clippy_comment`, `clippy_existential`). Backend Clippy is the "brain" (generates the witty/useless remark about the current article); frontend Clippy is the "body" (finds the quoted phrase in the Writer window, walks over, points at it, speaks). If you change one, check whether the other needs to follow.

There is also a **third, fully canned layer**: the frontend Clippy's per-app *profiles* in `registerClippyProfiles()` (idle phrases, greetings, per-app banks). Those require no LLM at all — they're just string arrays keyed by which app is focused.

---

## Architecture

### It is not a standalone binary in production

`package babelcom` exposes `Setup(router *gin.Engine) error` ([main.go](main.go)). In production it's mounted into the merged **babelcorp** binary at [cmd/babelcorp/main.go](../cmd/babelcorp/main.go), which dispatches by **Host header**:

- `babelcom.*` → the babelcom engine
- `wiki.*` / `web4` → the librarian engine
- bare `localhost`, IPs, anything else → **defaults to librarian (wiki)**

The `babelcom/Dockerfile` and `babelcom/README.md` describe an older world where babelcom built as its own binary. The live entrypoint is `cmd/babelcorp`. Trust the code over `babelcom/README.md` — see [Stale docs](#stale-docs-trust-the-code) below.

### Backend files

- **[main.go](main.go)** — `Setup()`, routing, and static-file serving. Static assets are `//go:embed static/*`, served with MD5 ETags + `Cache-Control`. A disk-serving mode (for dev hot-reload) is toggled by `BABELCOM_USE_DISK_STATIC=true`, optionally pointed at a dir via `BABELCOM_STATIC_PATH` (default `./static`).
- **[websocket.go](websocket.go)** — the message bus and all server state (`Server` struct). Two endpoints:
  - `GET /ws` — **unauthenticated** broadcast bus. Browser clients connect here to *receive*. On connect, the server replays cached state: `latestSystemStatus`, an `article_snapshot` of the token stream so far, and the last `radio` message.
  - `GET /ws/llm?api_key=…` — **authenticated** (key compared against `BABELCOM_API_KEY`). The `worker` connects here to *push*. Every message it sends is **raw-rebroadcast** to all `/ws` clients, and the server also inspects it to update cached state.
- **[clippy.go](clippy.go)** — backend Clippy (see below).
- **[health]** — `GET /health` returns connection counts and the current static-serving mode.

### The message bus vocabulary

Messages are JSON with a `type` field. The worker → backend → browser flow rebroadcasts most types verbatim. Types currently in play:

| Type | Direction | Meaning |
|---|---|---|
| `system_status` | worker → clients | CPU/memory/heat/uptime/articles_count/current_title/current_phase, etc. Cached + replayed on connect. |
| `token` | worker → clients | One streamed token of the article being written. Appended to `currentArticle` server-side and to `articleText` client-side. |
| `reset` | worker → clients | New article starting — clears the accumulated article buffer (server and client) and resets Clippy's sentence counter. |
| `article_snapshot` | backend → new client | Sent once on connect: the full article-so-far so a fresh/reconnecting tab can render it. |
| `clippy_comment` | backend → clients | `{quote, comment}` — backend Clippy's reaction to the article. |
| `clippy_existential` | backend → clients | `{quote}` only — a cheap "existential poke" (no LLM); the frontend supplies the line. |
| `radio` | backend → clients | `{type:"radio", payload:…}` — the upstream "now playing" feed, proxied and wrapped so it rides the same connection. |

> The legacy types documented in `babelcom/README.md` (`generation_status`, `current_word`, `output`) reflect an older protocol. Check the actual `switch` in `handleLLMWebSocket` and the bus handlers in `app.js` for what's really consumed today.

### Upstream radio

The backend dials an external AzuraCast WebSocket (`BABELCOM_UPSTREAM_RADIO_URL`, default `wss://radio.johncave.co.nz/...`), subscribes to a station, and rebroadcasts each "now playing" payload to clients wrapped as a `radio` message. A connection failure is logged and the rest of Babelcom keeps working.

### Backend Clippy ([clippy.go](clippy.go))

- Watches tokens as they're appended to the article. On each **new sentence boundary** (regex `[.!?](\s|$)`), it rolls a die: with probability `CLIPPY_TRIGGER_PERCENT` (default 30) it fires.
- At most **one Clippy turn in flight at a time** (atomic guard).
- 10% of fired turns are a cheap **existential poke** (`clippy_existential`, no LLM — picks a random phrase from the article); the other 90% call the model.
- The LLM call goes through a pluggable **backend** ([clippy_backends.go](clippy_backends.go)), selected by `CLIPPY_BACKEND`: **Ollama** (local, dev default) or **OpenRouter** (hosted, prod — OpenAI-compatible HTTP). Both send the same deliberately absurd system prompt (existential, useless, non-sequitur — *never* real writing advice) with `temperature: 1.4`, `top_p: 0.95`, capped output, and JSON-forced output `{highlight, comment}`. There's a tolerant fallback parser for when the model returns the wrong shape.
- Successful comments are persisted by **POSTing to librarian's `/api/clippy-comment`** (`BABELCOM_LIBRARIAN_URL` + `LIBRARIAN_API_KEY`) — babelcom no longer shares the article volume or imports the librarian package. The payload includes the quote's character offset within the article snapshot so the comment can be anchored precisely later. Best-effort; failures (incl. no librarian configured) are logged and dropped.
- If the selected backend can't initialize at startup (Ollama unreachable, or `OPENROUTER_API_KEY` unset), `NewClippy` returns `nil` and Clippy is simply disabled — everything else still runs.

---

## Frontend (`static/`)

Vanilla JS, **no build step, no bundler**. `index.html` loads plain `<script>` tags in order. Assets are embedded into the Go binary, so in embedded mode a static change needs a **Go rebuild** to show up (disk mode avoids this — see Running).

### The shell — [static/app.js](static/app.js)

The desktop itself. Key subsystems:

- **`BabelcomBus`** — the single client-side WebSocket connection to `/ws`. Pub/sub by message `type` via `subscribe(type, fn)`; caches the latest message per type (`getLatest`); maintains the rolling `articleText` buffer (fed by `article_snapshot` + `token`, cleared by `reset`); auto-reconnects with exponential backoff and drives the taskbar status light.
- **Frontend `Clippy`** — the clippyjs sprite manager (see the two-Clippys table). Per-app profiles, idle-phrase timers, greeting, drag-to-move-home (persisted), and the comment choreography: find the quoted phrase in `<babel-writer>`, park beside it, point, speak, then retreat. It deliberately **suppresses article reactions unless Writer is open and mostly visible** (`writerOcclusionFraction > 0.15` → drop the comment).
- **Window management** — wraps **WinBox** (`static/winbox.bundle.js`). `openApp(id, opts)` creates a window, mounts the app, and wires focus/move/resize/close/minimize/maximize.
- **Session persistence** — which apps are open and their geometry are saved to `localStorage` (`babelcom.session`), debounced, and restored on next load. First-ever visit (no saved session) shows the **setup picker** (wallpaper + radio choice) instead.
- **Boot sequence** — the fake BIOS/POST animation on load (click to skip).
- **Dock magnifier** — macOS-style cosine-falloff dock that physically re-flows tiles (sets width/height, not `transform: scale`).
- **`window.BabelcomAPI`** — the public surface apps use: `openApp`, `subscribe`, `getLatest`, `getArticleText`, `formatBytes`, `formatUptime`, etc.

### Apps — [static/apps/](static/apps/)

There are **two app patterns**. Prefer the first for anything new.

1. **Tag-based (shadow-DOM custom elements)** — preferred. The app is a `customElements.define(...)` class with its own isolated CSS/DOM. Registered with a `tag:` in `registerApp`. The shell mounts the element into the WinBox body; `connectedCallback`/`disconnectedCallback` handle setup/teardown.
2. **Component-based (legacy global object)** — a global like `RadioApp` with `init(el, config, winbox)` / `destroy()`. Only **Radio** still uses this (there's a TODO to migrate it — Butterchurn + the audio context make it fiddly).

| App | Element / object | Notes |
|---|---|---|
| **System Monitor** | `babel-system-monitor` | Live CPU/Memory/Heat graphs from `system_status`. Slides its 60s window even with no new data. |
| **Wikibabel** (a.k.a. library-browser) | `babel-library-browser` | An iframe onto the sibling `wiki.*` host (derived from the current `babelcom.*` host; falls back to prod). |
| **Radio** | `RadioApp` (legacy) | Butterchurn (MilkDrop) visualizer with adaptive resolution scaling for FPS; can render as desktop wallpaper. The most complex app by far. |
| **Writer** | `babel-writer` | Renders the streaming article as a Word-97-styled document (98.css chrome). Strips links to plain text. Exposes `findAndHighlight(quote)` — this is what frontend Clippy points at. |
| **Welcome** | `babel-welcome` | The intro/onboarding slides ("Babelcorp Employee #419"). |

### Vendored / CDN libraries

- `static/winbox.bundle.js` — window manager (vendored).
- `static/vendor/` — `98.css` (Win98 chrome), `marked.min.js` (markdown), `butterchurn*.js` (visualizer), `ms_sans_serif` fonts.
- **clippyjs** — loaded from a CDN as an ES module by [static/clippy-init.js](static/clippy-init.js) (esm.sh). Kept tiny and isolated so a CDN miss doesn't take down the desktop.

---

## Running it

### Dev (recommended): `air` from the repo root

```bash
air   # uses .air.toml at the repo root
```

This builds `cmd/babelcorp` and runs it with `PORT=18080`, disk-static mode on, and the article/wiki dirs pointed at the in-repo folders. Live-rebuilds on `.go/.html/.css/.js/.md` changes.

> **Gotcha:** routing is by Host header, and bare `localhost` defaults to the **wiki**, not babelcom. To hit Babelcom in dev, use **`http://babelcom.localhost:18080`** (browsers resolve `*.localhost` to loopback). Plain `http://localhost:18080` gives you the encyclopedia.

### Building the production binary

```bash
go build -o babelcorp ./cmd/babelcorp
```

(See the repo-root `Dockerfile` for the container build — it ships the merged binary plus the hand-written wiki content.)

### Static changes & the rebuild rule

- **Embedded mode** (default in prod): assets are baked in by `//go:embed`. A change to anything in `static/` needs a **Go rebuild**. `air` watches JS/CSS/HTML and rebuilds for you.
- **Disk mode** (`BABELCOM_USE_DISK_STATIC=true`): assets are read from disk per request, so edits show up on refresh without a rebuild. This is what `air` uses.

---

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port (`air` sets `18080`). |
| `BABELCOM_API_KEY` | `babelcom-secret-key` | Key required on `/ws/llm`. **Set a real one in prod.** |
| `BABELCOM_USE_DISK_STATIC` | unset | `true` → serve `static/` from disk instead of the embed. |
| `BABELCOM_STATIC_PATH` | `./static` | Disk dir to serve when disk mode is on. |
| `BABELCOM_UPSTREAM_RADIO_URL` | `wss://radio.johncave.co.nz/...` | Upstream AzuraCast "now playing" WebSocket. |
| `CLIPPY_BACKEND` | `ollama` | LLM transport for backend Clippy: `ollama` (local, dev default) or `openrouter` (hosted, prod). |
| `CLIPPY_MODEL` | backend-specific | Model override. Defaults to `granite4.1:8b` (Ollama) / `ibm-granite/granite-4.1-8b` (OpenRouter). |
| `CLIPPY_TRIGGER_PERCENT` | `30` | Probability (0–100) Clippy fires per new sentence. |
| `OPENROUTER_API_KEY` | — | Required when `CLIPPY_BACKEND=openrouter`. If unset, Clippy disables itself. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter API base (override for proxies/testing). |
| `OPENROUTER_REFERER` | — | Optional `HTTP-Referer` header for OpenRouter dashboard attribution. |
| Ollama env (`OLLAMA_HOST`, …) | — | Standard Ollama client env (used when `CLIPPY_BACKEND=ollama`). If Ollama is unreachable, Clippy disables itself. |

---

## Conventions & gotchas

- **Keep the tone.** Useless, mundane, doomed. New Clippy lines and UI copy should match.
- **Two Clippys** — re-read the table above before touching either.
- **Host-based routing** — `babelcom.localhost` in dev, not bare `localhost`.
- **Embedded statics** need a Go rebuild unless you're in disk mode.
- **No frontend build** — plain scripts in dependency order in `index.html`. Prefer shadow-DOM custom elements for new apps.
- **No JS runtime on this machine** — there's no `node`/`deno`/`bun`, so you can't `node --check` or lint JS from the shell. Verify frontend changes by reading carefully and loading the app in a browser (`air` + `babelcom.localhost:18080`); only the Go side has a compiler to lean on.
- **Standalone services** — babelcom and librarian are now separate deployments (`cmd/babelcom`, `cmd/librarian`); babelcom does **not** import librarian. Clippy persistence is an HTTP POST to librarian's `/api/clippy-comment`. `cmd/babelcorp` (merged, host-routed) remains only as the `air` dev convenience.
- **CORS / origin checks are wide open** (`CheckOrigin` returns true). Fine for an art piece; note it if that ever matters.

### Stale docs: trust the code

[babelcom/README.md](README.md) predates the current architecture. It documents a separate binary, `npm start`, a `/ws/broadcast` endpoint (now just `/ws`), and message types (`generation_status`, `current_word`, `output`) that the live code no longer keys on. When the README and the code disagree, **the code is right.** `test-llm-client.js` is likewise an old manual test harness, not a current contract.
