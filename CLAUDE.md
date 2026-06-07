# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**モシラス** — a **turn-based** 雀荘 (free mahjong parlor) management simulation game. You play the floor manager: seat customers at tables, fill empty seats by playing 本走 (staff sit-in), swap/combine tables, and maximize 売上 (revenue from 場代 game fees) from open to close. Time only advances when you press **「次のイベントへ」**, which fast-forwards (animated) until the next decision point and auto-stops. Astro 5 + Tailwind v4 static site (**light theme**), deployed to GitHub Pages. Live: https://satory074.github.io/moshirasu/

## Commands

```bash
npm install
npm run dev        # http://localhost:4321/moshirasu/  (base path matters — see Gotchas)
npm run build      # production build → dist/ (also the real typecheck via vite)
npm run typecheck  # astro check
npm run test       # both smoke tests: tsx scripts/smoketest.ts && tsx scripts/domtest.ts
```

Run a single test directly: `npx tsx scripts/smoketest.ts` (pure engine: zero-sum settlement, full-day playthroughs) or `npx tsx scripts/domtest.ts` (jsdom: render + interactions + result screen). There is no watch/single-case runner — the scripts are plain `tsx` harnesses with inline `assert`, not a framework.

Deploy: push to `main` → `.github/workflows/deploy.yml` builds and publishes to Pages. No manual step.

## Architecture

The entire game is a **single authoritative `GameState` object** mutated in exactly two places — the `tick()` loop and the `actions.*` command functions — with the DOM as a pure projection of that state. Everything under `src/game/` is framework-free; **only `render.ts` and `main.ts` touch the DOM**. Keep it that way: the DOM-free core is what makes the engine unit-testable in Node/tsx.

Data flow: the player presses 「次のイベントへ」 → `engine.advance()` runs an rAF loop that calls `tick(state)` at `CONFIG.advanceTickMs` pace, re-rendering each step, and **auto-stops at the next decision point** (`detectStop`) → `render(state)` projects to DOM. Other user clicks → `render.ts` builds a `Command` → `main.ts` dispatch → `actions.*` validates + mutates state + logs → returns `Result` → toast + re-render. (There is no auto-advance; idle = no rAF.)

Module map (all in `src/game/`):

| File | Role |
|---|---|
| `types.ts` | All entity types. Single source of truth, no logic (avoids circular imports). |
| `config.ts` | **ALL balance constants** live in the frozen `CONFIG`. Tune here, nowhere else. |
| `rng.ts` | Seeded mulberry32 PRNG. |
| `state.ts` | `createInitialState`, `addLog`, `nextId`, `addRevenue`, `adjustReputation`. The container, not the rules. |
| `economy.ts` | Per-半荘 settlement math (着順→点棒→オカ/ウマ/祝儀→円), 場代 collection, bankroll. Pure. |
| `customers.ts` | Arrival spawning, stat rolls, wait/rage-quit, post-半荘 leave/stay decision. |
| `tables.ts` | Table/seat logic + the 半荘 state machine, 本走/swap/combine. The biggest rules module. |
| `actions.ts` | Player command layer. Each returns `Result`; UI mutates state *only* through here. |
| `engine.ts` | Turn-based `advance()` (event-driven auto-stop via `detectStop`) + the deterministic per-tick orchestration order in `tick()`. |
| `selectors.ts` | Read-only derived views for rendering (formatClock, kpis, progress ratios). |
| `render.ts` | state→DOM. Keyed element maps + event delegation. Owns transient UI selection state. |
| `main.ts` | Composition root: wires state→renderer→engine, handles restart and the spacebar = 「次のイベントへ」 shortcut. |

### Things that require reading multiple files to understand

- **Determinism / replay**: every random draw goes through `state.rng` (seeded from `?seed=` or `Date.now()` once at boot). `?seed=12345` reproduces an entire run. Never use `Math.random()` / `Date.now()` inside game logic — only at the boot seed in `main.ts`.

- **Turn advance** (`engine.ts`): `advance()` runs an rAF loop that ticks at `CONFIG.advanceTickMs` pace until `detectStop` fires, then sets `state.advancing=false` and halts (no rAF while idle). `detectStop` compares a pre-tick snapshot to the new state and stops on: closed / new arrival / a table newly `WAITING_TO_START` with an empty seat / a table newly `EAST` with a 本走 seat while customers wait (交代 chance) / a waiting customer newly crossing `CONFIG.urgentRatio`. It deliberately does **not** re-stop on a still-`WAITING_TO_START` table (avoids pointless repeat stops). The per-tick order in `tick()` is fixed and load-bearing: clock → close check → arrivals → wait/rage → per-table `advanceHanchan` → final close check.

- **The 半荘 state machine** (`tables.ts` `advanceHanchan`): `WAITING_TO_START → EAST → SOUTH → SETTLING → DONE→loop`. Calls (ラスハン/モシラス) are rolled at the `→EAST` transition; settlement + leave-or-stay happens in the single `SETTLING` tick. **Swap (交代) is only legal during `EAST` on a table with a 本走 seat** — it's the one mid-半荘 player action.

- **Settlement is zero-sum** (`economy.ts`): point spread is normalized to sum 0, then オカ/ウマ re-zeroed, then converted to yen by rate. 祝儀 exists only on BLUE(点5) and is itself zero-sum (losers pay the winner). `bigSwingChance`/`bigSwingMult` add a heavy tail so a thin-stacked player can actually 飛ぶ (bust) on 点5 — that's the high-stakes risk the game is built around. The smoke test asserts GREEN settlements sum to 0.

- **本走 earns no 場代**: only `CUSTOMER` seats pay (`collectGameFee`). Staff sit-in is a tool to start a table with <4 customers, never free revenue. Routing flexible (ANY) customers to BLUE for higher 場代 vs. the higher bust variance is the central optimization.

- **Restart id-reuse trap**: `createInitialState` resets `nextId` to 1000, so a new game reuses the previous game's entity ids. `render.ts` keyed maps would bind stale DOM nodes — `renderer.reset()` (called in `main.startNew`) clears the maps and regions to prevent this.

## Gotchas

- **`as const` literal narrowing**: `CONFIG` is `as const`, so locals seeded from it infer narrow literal types. When a value is later reassigned (e.g. a probability `p`), annotate `let p: number = CONFIG.x` or tsc errors.
- **Base path**: production serves under `/moshirasu`. Astro handles asset URLs; the dev URL is `/moshirasu/`. `astro.config.mjs` sets `base: "/moshirasu"`.
- **Tailwind v4 + Astro type mismatch**: the Vite plugin is cast `any` in `astro.config.mjs` (`/** @type {any} */ (tailwindcss())`).
- **`scripts/*.ts` need `tsx` + `jsdom`** (devDependencies). `domtest.ts` injects DOM globals *before* dynamically importing `render.ts`.
