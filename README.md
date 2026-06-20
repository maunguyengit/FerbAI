# FerbAI — Brutalist Whiteboard + AI Tutor

A whiteboard on the left (draw, like Excalidraw), an AI study companion on the
right that **sees your board** and guides you to the next step. Built with
React + TypeScript + Vite. Brutalist theme: thick black rules, hard offset
shadows, electric-yellow accent.

## Run it

```bash
npm install
cp .env.example .env     # then paste whatever keys you have (all optional)
npm run dev              # starts the Vite frontend AND the backend proxy together
```

Open http://localhost:5173. `npm run dev` runs both processes via `concurrently`
(`web` = Vite on 5173, `api` = proxy on 8787). Vite forwards `/api/*` to the
proxy, so there's nothing else to configure.

You don't strictly need a `.env` — you can paste keys into the in-app
**Settings (⚙)** panel instead (see below).

## Use it

1. **Draw** your problem on the left — pen, eraser, lasso (select + drag +
   `Delete`), text, box, oval. Pick colour + stroke width. `Ctrl+Z` / `Ctrl+Shift+Z`
   undo/redo. `⤓ PNG` downloads the board.
2. **Pick a model** in the dropdown (top-right). Vision-capable models can read
   the board snapshot — look for the `👁 sees board` chip.
3. **Add your API key.** Two ways, your choice:
   - **Backend `.env`** (recommended) — keys never touch the browser. The status
     chip shows `● key set` automatically.
   - **Settings (⚙)** — paste a key in the UI. It's stored in your browser's
     `localStorage` and forwarded to the local proxy per request, overriding the
     `.env` key. Leave a field blank to fall back to the server key.
4. **Ask →**. With *attach board snapshot* on, the AI gets a PNG of your drawing
   and nudges you toward the next step (Socratic — not the full answer).

## Models & providers

| Provider (dropdown group) | API style | Models |
| --- | --- | --- |
| **Claude Code** | Anthropic | Opus 4.8 · Sonnet 4.6 · Haiku 4.5 |
| **DeepSeek** | OpenAI-compatible | DeepSeek V3 · DeepSeek R1 |
| **OpenCode Go plan** | OpenAI-compatible | MiniMax M3 · Kimi K2.6 · GLM · Qwen |

Each provider's **Base URL** is editable in Settings, so you can point the
OpenAI-compatible groups at any gateway (OpenRouter, a self-hosted proxy, the
real OpenCode Go endpoint, etc.). Adjust model IDs in
[`src/lib/providers.ts`](src/lib/providers.ts) to match your gateway.

## Graph window (Desmos-style 2D + 3D) the AI can plot on

Toggle the left panel between **✎ Board** and **∿ Graph** (top bar). The graph
window takes typed equations and the AI can plot onto it too.

- **Type equations** in the side rail: explicit `y = x^2 + 9`, surfaces
  `z = x^2 - y^2`, or implicit relations `x^2 + y^2 + z^2 = 9`. Anything using
  `z` renders in **3D** (drag to rotate, scroll to zoom); otherwise **2D**.
  Click a color dot to show/hide, double-click to recolor, `×` to delete.
- **The AI plots too.** In the graph view, ask things like *"graph the
  derivative and integral of y = x³ + 3x²"* or *"plot a cubic that intersects
  this parabola"*. The model **does the calculus itself** and emits a
  `ferbai-graph` block of equations, which the app plots (marked `✦` as
  AI-added). It sees the current graph (snapshot + equation list) so it builds
  on what's there.

Built on [Plotly.js](https://plotly.com/javascript/) (2D lines/contours, 3D
surfaces/isosurfaces) + [mathjs](https://mathjs.org/) (parsing/evaluation). The
equation engine lives in [`src/lib/graph.ts`](src/lib/graph.ts); the panel in
[`GraphView.tsx`](src/components/GraphView.tsx).

> Note: bundling Plotly makes the production JS large (~5.7 MB / 1.7 MB gzip).
> Fine for local use; code-split it (lazy-load the graph) before shipping wide.

## The AI writes ON the board (not just chat)

FerbAI's tutor doesn't only talk in the sidebar — it **writes the next step onto
the whiteboard**, in the empty space, like a teacher at a board. Draw `3x = 12`,
ask "solve for x", and it writes `3x / 3 = 12 / 3` in blue directly below your work.

How it stays accurate (instead of guessing pixel positions blind):

1. **The app tells the model the geometry.** Every request includes the board
   size and the bounding box of your existing strokes
   ([`getBoardMeta`](src/components/Whiteboard.tsx)), so the model knows exactly
   where the empty space is.
2. **The model returns structured draw commands** in a fenced `ferbai-draw` JSON
   block — `text`, `arrow`, `line`, `rect`, `ellipse` (circle the answer), and
   `highlight` (mark a mistake on your work). The block is parsed out of the chat
   text and rendered as real, **undoable** board elements in AI-blue, with a
   fade-in ([`drawblock.ts`](src/lib/drawblock.ts), `applyAIActions`).
3. **The "✎ AI draws on board" toggle** (on by default) injects a firm directive
   so the model draws whenever you want it — turn it off for pure chat.

Use a **vision** model (look for `👁 sees board`) so it can read your actual
handwriting; the geometry hints help non-vision models place text too. Anything
the AI draws is just board elements — undo it, erase it, or move it like your own.

## How the backend helps

All model calls go through a thin local proxy ([`server/index.js`](server/index.js))
instead of straight from the browser. That buys you three things:

- **No CORS pain.** The browser only ever calls same-origin `/api/*`. The proxy
  makes the real provider call server-side, where CORS doesn't apply.
- **Keys can stay off the client.** Put them in `.env` and the browser never sees
  them.
- **One normalized stream.** Anthropic and OpenAI shapes are unified into a single
  SSE format (`data: {"t": "…"}`), so the frontend has one tiny parser.

The proxy never persists anything — `.env` keys are read at start, UI-pasted keys
are used for that one request and discarded.

## CORS / providers

The OpenAI-compatible groups (DeepSeek, OpenCode Go) have **editable Base URLs**
in Settings, so you can point them at any gateway (OpenRouter, a self-hosted
proxy, the real OpenCode Go endpoint). Adjust the model IDs in
[`server/providers.js`](server/providers.js) **and**
[`src/lib/providers.ts`](src/lib/providers.ts) to match your gateway.

## Structure

```
server/
  index.js                 thin streaming proxy: /api/chat, /api/providers, /api/health
  providers.js             server-side model catalog + system prompt + env-key mapping
src/
  App.tsx                  layout: board (left) + chat (right)
  components/
    Whiteboard.tsx         canvas drawing engine + tools + undo/redo + PNG export
    Toolbar.tsx            tools · colours · widths · undo/redo/clear/download
    ChatPanel.tsx          streaming chat, model selector, vision toggle, clear
    ModelSelector.tsx      grouped provider → model dropdown
    SettingsModal.tsx      per-provider API key + base URL (optional override)
  lib/
    providers.ts           provider + model catalog (UI)
    ai.ts                  talks to the proxy, parses the normalized stream
    storage.ts             localStorage for optional keys / urls / selection
    types.ts               shared types
tokens.css                 portable Hallmark Brutal design tokens
.env.example               backend keys template → copy to .env
```
