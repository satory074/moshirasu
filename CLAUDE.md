# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**モシラス** — a **turn-based** 雀荘 (free mahjong parlor) management simulation game. You play the floor manager: **decide the staff headcount on a pre-open setup screen** (1〜`maxTables*4`, fixed for the day — no in-play hiring), then seat customers at tables, fill empty seats by playing 本走 (staff sit-in), swap/combine tables, and maximize **利益 (profit = 場代売上 − 人件費)** from open to close. On 閉店 you enter a name and **submit your profit to a ranking** (local by default; shared via Supabase if env is set). Time only advances when you press **「次のイベントへ」**, which fast-forwards (animated) until the next decision point and auto-stops. Astro 5 + Tailwind v4 static site (**light theme**), deployed to GitHub Pages. Live: https://satory074.github.io/moshirasu/

Each 半荘 is simulated **局-by-局** (東1局〜南4局, 親番ローテ, 連荘/本場): every 局 moves **real 点棒** between the 4 seats (zero-sum, staff included), and final placement is decided by accumulated 点棒 — not a one-shot roll. 点5(BLUE) hands swing harder (`blueHandMult`), so a thin-stacked customer can 飛ぶ (bust). Up to **12 tables** (`CONFIG.maxTables`).

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

Shared ranking (optional): copy `.env.example` → `.env` and set `PUBLIC_SUPABASE_URL`/`PUBLIC_SUPABASE_ANON_KEY` (else ranking stays local-only via localStorage). The same vars go in the repo's Actions **Secrets** for production. No keys configured = builds/tests/dev still work.

## Architecture

The entire game is a **single authoritative `GameState` object** mutated in exactly two places — the `tick()` loop and the `actions.*` command functions — with the DOM as a pure projection of that state. Everything under `src/game/` is framework-free; **only `render.ts` and `main.ts` touch the DOM**. Keep it that way: the DOM-free core is what makes the engine unit-testable in Node/tsx.

Data flow: the player presses 「次のイベントへ」 → `engine.advance()` runs an rAF loop that calls `tick(state)` at `CONFIG.advanceTickMs` pace, re-rendering each step, and **auto-stops at the next decision point** (`detectStop`) → `render(state)` projects to DOM. Other user clicks → `render.ts` builds a `Command` → `main.ts` dispatch → `actions.*` validates + mutates state + logs → returns `Result` → toast + re-render. (There is no auto-advance; idle = no rAF.)

Module map (all in `src/game/`):

| File | Role |
|---|---|
| `types.ts` | All entity types. Single source of truth, no logic (avoids circular imports). |
| `config.ts` | **ALL balance constants** live in the frozen `CONFIG`. Tune here, nowhere else. |
| `rng.ts` | Seeded mulberry32 PRNG. |
| `state.ts` | `createInitialState(seed, staffCount?)`, `addLog`, `nextId`, `addRevenue`, `adjustReputation`. The container, not the rules. `staffCount` is chosen on the setup screen (default `CONFIG.staffCount`). `expenses.wages` accrues here-adjacent (in `engine.tick`). |
| `economy.ts` | Per-半荘 settlement math: ranks seats by **accumulated real 点棒**, then 素点→オカ/ウマ/祝儀→円. 場代 collection, bankroll. Pure. |
| `customers.ts` | Arrival spawning, stat rolls, wait/rage-quit, post-半荘 leave/stay decision. |
| `tables.ts` | Table/seat logic + the 局-driven 半荘 engine (`advanceHanchan`/`advanceKyokus`/`resolveKyoku`), 本走/swap/combine/rate-change (`canChangeRate`), `tickSeatedWaiting`. The biggest rules module. |
| `actions.ts` | Player command layer. Each returns `Result`; UI mutates state *only* through here. Seat/honso/swap target a **specific seat index** (`seatCustomerAction(...,seatIdx)`, `honsoAction(...,seatIdx,staffId)`, `swapAction(...,seatIdx)`); `moveCustomerAction` moves a 半荘前 seated customer to a pref-matching 半荘前 table's empty seat (and `teardownTable`s the source if it empties). (No `hireStaffAction` — staff is fixed at setup.) |
| `engine.ts` | Turn-based `advance()` (event-driven auto-stop via `detectStop`) + the deterministic per-tick orchestration order in `tick()`. |
| `ranking.ts` | Score persistence. `RankingStore` interface (async) with `LocalRankingStore` (localStorage/memory, DI'd storage) + `SupabaseRankingStore` (plain `fetch` to PostgREST, no SDK). `createRankingStore()` picks Supabase if `PUBLIC_SUPABASE_*` env is set, else local. `buildScoreEntry`/`percentile`. DOM-free. |
| `selectors.ts` | Read-only derived views for rendering (formatClock, `kpis` incl. `profit`/`wages`, `kyokuLabel`, progress ratios). |
| `render.ts` | state→DOM. Keyed element maps + event delegation. Owns transient UI state outside `GameState`: 待ち客 selection, the `#setup` staff-count stepper, the result-screen ranking view (`createRankingStore`), and the **seat picker** (`ui.pickSeat`). Clicking an empty seat (`pick-seat`), a 本走 seat (`pick-swap`), or a 席埋め中 customer seat (`pick-move`, 半荘前のみ) opens `#picker`. Seat/swap pickers list `choose` candidates with `data-kind` (cust/staff/move/swap); the `pick-move` picker is **客起点** (the customer is fixed, ピッカーは移動先卓を `data-kind="moveDest"` 行で並べる→`moveCustomerAction`). The seat-picker `move` kind (移動先起点) も併存。 **No per-table 案内/本走/交代 buttons** — only 合卓/レート切替 remain. |
| `main.ts` | Composition root: wires state→renderer→engine. Boot shows the setup screen (not auto-start); `startGame(staffCount)` begins play; `restart` returns to setup. Spacebar = 「次のイベントへ」. |

### Things that require reading multiple files to understand

- **Determinism / replay**: every random draw goes through `state.rng` (seeded from `?seed=` or `Date.now()` once at boot). `?seed=12345` reproduces an entire run. Never use `Math.random()` / `Date.now()` inside game logic — only at the boot seed in `main.ts`.

- **Turn advance** (`engine.ts`): `advance()` runs an rAF loop that ticks at `CONFIG.advanceTickMs` pace until `detectStop` fires, then sets `state.advancing=false` and halts (no rAF while idle). `detectStop` compares a pre-tick snapshot to the new state and stops on: closed / new arrival / a table newly `WAITING_TO_START` with an empty seat / a table newly `EAST` with a 本走 seat (交代 chance) / a table newly **「まもなく開始」(full + 本走) while customers wait** (last chance to swap the staff before start) / a waiting **or seated-but-not-started** customer newly crossing `CONFIG.urgentRatio`. It deliberately does **not** re-stop on a still-`WAITING_TO_START` table. The per-tick order in `tick()` is fixed and load-bearing: clock → **wages accrual** → close check → arrivals → wait/rage → **seated-waiting rage** (`tickSeatedWaiting`) → per-table `advanceHanchan` → final close check. **rAF caveat**: in a non-focused/background tab the browser throttles `requestAnimationFrame`, so `advance()` won't progress — verify engine behavior via the tsx/jsdom harnesses, not a backgrounded browser tab.

- **The 局-driven 半荘 engine** (`tables.ts`): macro `status` is `WAITING_TO_START → EAST → SOUTH → SETTLING → loop`, but EAST/SOUTH are now **場** that contain individual 局. `advanceHanchan` accumulates `elapsedMin`; every `CONFIG.kyoku.kyokuMin` boundary `advanceKyokus` calls `resolveKyoku` (流局 or 和了者抽選 by skill/luck softmax + 親補正 → ツモ/ロン → **moves real 点棒, zero-sum, integer**) and advances 局/場/親 (連荘 = 親 stays + `honba++`). The 半荘 ends on **飛び (any seat 点棒 < 0)**, オーラス完了, or `maxKyokuPerHanchan`. Half-hanchan length is now **variable** (連荘 lengthens it). Calls (ラスハン/モシラス) are rolled at `startHanchan`; settlement + leave/stay in the `SETTLING` tick. **Swap (交代) is legal during `EAST` OR at 「まもなく開始」(WAITING_TO_START, full, 本走 seat)** — see `canSwapHonso`.

- **Settlement is zero-sum** (`economy.ts` `settleHanchan`): ranks the 4 seats by **accumulated real 点棒** (tie → 起家/席順), then 素点 `= (点棒 − kaeshi)/1000`, +オカ to 1st, +ウマ — which sum to 0 because Σ点棒 ≡ 100000 (the 局 engine keeps it exact). Converted to yen by rate. 祝儀 exists only on BLUE(点5), itself zero-sum. The smoke test asserts GREEN settlements sum to 0 **and** that in-play Σ点棒 == 100000 every tick. (The old cosmetic `driftPoints` and `pointSpread`/`bigSwing*` spread model are **gone**; `CONFIG.kyoku.handValues` + `blueHandMult` now drive the heavy tail / bust risk.)

- **本走 earns no 場代**: only `CUSTOMER` seats pay (`collectGameFee`); staff play real 点棒 but their yen result is ignored (no bankroll) and they never 飛ぶ-leave. Staff sit-in starts a table with <4 customers. **The staff headcount is chosen once on the pre-open setup screen (1〜`CONFIG.maxTables*4`, default `CONFIG.staffCount`) and cannot change mid-day** — more staff = more 本走 capacity but accrues `wagePerHourYen` every tick → 利益 = 売上 − 人件費. Routing flexible (ANY) customers to BLUE for higher 場代 vs. higher bust variance, and **sizing staff at setup vs. wage drag**, are the central optimizations.

- **Setup screen & ranking flow** (`render.ts`/`main.ts`/`ranking.ts`): boot shows `#setup` (店員数 stepper) instead of starting; `start-game` → `Command{startGame,staffCount}` → `main.startGame` → `createInitialState(seed, staffCount)`. `restart` returns to `#setup` (re-choose). On 閉店, `renderResult` builds the result card **once** (`rankingView.builtForClosed`, so the name `<input>` isn't clobbered on re-render), async-loads `fetchTop(10)`, and `submit-score` posts via the `RankingStore`. Ranking display/submit is renderer-owned transient state (not in `GameState`). Player name + personal-best live in `localStorage` (`moshirasu.playerName`/`moshirasu.bestProfit`).

- **Seated-but-not-started counts as waiting**: `markSeated` no longer resets `waitedMin`; a customer seated at a not-yet-full table keeps accumulating impatience (at `CONFIG.kyoku.seatedWaitMult` rate) via `tickSeatedWaiting` and can rage-quit from the seat. `waitedMin` resets only when the 半荘 actually starts (`startHanchan`).

- **Restart id-reuse trap**: `createInitialState` resets `nextId` to 1000, so a new game reuses the previous game's entity ids. `render.ts` keyed maps would bind stale DOM nodes — `renderer.reset()` (called in `main.startNew`) clears the maps and regions to prevent this.

## Gotchas

- **`as const` literal narrowing**: `CONFIG` is `as const`, so locals seeded from it infer narrow literal types. When a value is later reassigned (e.g. a probability `p`), annotate `let p: number = CONFIG.x` or tsc errors.
- **Base path**: production serves under `/moshirasu`. Astro handles asset URLs; the dev URL is `/moshirasu/`. `astro.config.mjs` sets `base: "/moshirasu"`.
- **Tailwind v4 + Astro type mismatch**: the Vite plugin is cast `any` in `astro.config.mjs` (`/** @type {any} */ (tailwindcss())`).
- **`scripts/*.ts` need `tsx` + `jsdom`** (devDependencies). `domtest.ts` injects DOM globals *before* dynamically importing `render.ts`. 2つ目の `createRenderer` を別ルートに作るとき（ピッカーの単体テスト等）は、先に旧 `#app` を `root.remove()` すること: jsdom はスコープ付き `querySelector("#id")` が文書内に重複IDがあると null を返すため、SHELL の `#clock` 等が二重になると `must()` が落ちる（本番は単一 renderer なので無問題）。
- **客は最低3半荘打つつもり（ソフト保証）**: `Customer.hanchansPlayed` を `settleTable` で数え、`config.ts` の `minHanchanIntent`(3) 未満なら `decideLeaveOrStay`(customers.ts) と `rollCalls`(tables.ts) で自主離席/ラスハン確率を `under3LeaveMult`/`under3LasthanMult`(0.15) で抑制。飛び・時間切れ・閉店は従来通り強制離席。
- **進行ボタンは2箇所に描画**: `renderAdvance` は同じ「次のイベントへ」ボタンを HUD内 `#advance-wrap`（PC）と画面下部固定の `#advance-bar`（スマホ）の両方に注入し、CSS `@media (max-width:960px)` でどちらか一方だけ表示する。片方だけ直すとレイアウトがずれる。
- **モバイルのログ折りたたみはJSなし**: `#log-toggle` チェックボックス＋label の CSS 兄弟セレクタ（`@media (max-width:960px)`）で開閉。エンジンは従来通り `#log` に描画するだけ。
- **局シミュ定数は `CONFIG.kyoku` に集約**: `kyokuMin`/`ryuukyokuProb`/`tsumoProb`/`winSkillW`/`winLuckW`/`dealerWinMult`/`handValues`/`blueHandMult`/`maxKyokuPerHanchan`/`maxHonba`/`seatedWaitMult`。半荘長・飛び頻度・1日の半荘数（=売上）はここで決まる。`handValues`/`blueHandMult` を上げると点5の飛びが増えるが反動でブレも増える。スコア評価は `scoreRank(利益)`＝`targetProfit` 基準（旧 `targetRevenue` は参考値）。

- **交代受諾は客ごとの多要素判定**（`attemptSwap`／`CONFIG.swap`）: 受諾確率 `p` は **継ぐ本走席の点棒**(`kPoints`)・**トップとの差**(`kTopGap`, 主要な抑制)・**親残存**(`dealerBonus` + 残り局 `kRemain`)・**自分の待ち時間**(`kWait`, 長いほど受諾↑)・**客の性格** `Customer.swapTol`(spawn時に `CONFIG.swapTol` でroll, `kTol`)から合成し `[pMin,pMax]` でクランプ。`base` を高くしてあるので**局頭（点棒互角・トップ差0・残り多）はほぼ受諾**＝開始直後の不自然な拒否が出ない。**一度断った卓は `Customer.refusedTables` に記録**し、`swapAction` と swapピッカーで同一卓への再オファーを除外する。旧 `kLateMin`（帰宅間近で渋る）は廃止。
- **店員IDは固定域・客/卓IDは1000+**: `createInitialState` の店員は `id:0,1,…`（`nextId` の1000+域と衝突しない）。`staffName(idx)` は4人を超えると `メンバー N` にフォールバック（設定で最大 `maxTables*4`=48人まで選べるが破綻しない）。

- **ランキングは外部書き込み先が要る**: 共有ランキングは GitHub Pages 単体では不可（静的配信＝書き込み不可）。`PUBLIC_SUPABASE_URL`/`PUBLIC_SUPABASE_ANON_KEY`（Astro は `PUBLIC_` プレフィックス必須、`NEXT_PUBLIC_` ではない）を `.env`/Actions Secrets に設定すると Supabase 共有、未設定ならローカル（localStorage）に自動フォールバック。Supabase 側は `scores` テーブル＋RLS（SELECT/INSERT のみ・`WITH CHECK` で値制約）。`@supabase/supabase-js` は入れず素の `fetch` で PostgREST を叩く（依存ゼロ）。anon key は RLS 前提で公開可、**service_role key は置かない**。env の雛形は `.env.example`。`scores` の列は `id/name/profit/rank/staff_count/served/hanchan/seed/at_iso`（`ScoreEntry` の snake_case 版、`ranking.ts` の `toRow`/`fromRow` で変換）。`WITH CHECK` は名前長・利益上下限・staff範囲・rank列挙を検証。
- **卓グリッドは `auto-fill minmax(240px,1fr)`**: `maxTables:12` でも `#tables` のCSSはそのまま流れる（`index.astro` の `<style is:global>`）。`卓 N/12` 表記は `CONFIG.maxTables` 参照で自動追従。
- **合卓はレート違いでもOK・レート変更も可**: `canCombine` は構造条件（半荘前・客合計1〜4）だけを見て、レート整合は `combineAction` が判定する。両卓の客の希望を両立できるレート（`combineRate`）へ集約し、点5希望と点3希望が混在する場合のみ拒否。`changeRateAction`/`canChangeRate` は「半荘前・客が全員ANY(どちらでも)」の卓のレートを点5⇄点3で切替（混在卓では不可）。どちらも `Customer.pref` を尊重するのが不変条件。
