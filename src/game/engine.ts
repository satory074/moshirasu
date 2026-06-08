// ===== ターン制エンジン（イベント駆動の自動進行）=====
// 自動では進まない。「次のイベントへ」(advance) で、判断が必要な
// イベント（来店/半荘終了で空席/交代機会/待ち客の緊急化/閉店）まで
// 一定ペース（advanceTickMs）で tick() を回し、そこで自動停止する。
// ゲームロジックは全て tick() 駆動＝実時計を読まないので決定論・seedリプレイは不変。

import { CONFIG } from "./config";
import { maybeSpawnArrival, tickWaiting } from "./customers";
import { patienceRatio } from "./selectors";
import { addLog } from "./state";
import { advanceHanchan, tickSeatedWaiting } from "./tables";
import type { Customer, GameState, HanchanStatus } from "./types";

/** 開始待ち（満席前）の卓に着席し、まだ半荘が始まっていない客の一覧。 */
function seatedWaiting(state: GameState): Customer[] {
  const out: Customer[] = [];
  for (const t of state.tables) {
    if (t.progress.status !== "WAITING_TO_START") continue;
    if (t.seats.every((s) => s.occupant.kind !== "EMPTY")) continue; // 満席は開始される
    for (const s of t.seats) {
      if (s.occupant.kind !== "CUSTOMER") continue;
      const c = state.customers.get(s.occupant.customerId);
      if (c) out.push(c);
    }
  }
  return out;
}

/** 「まもなく開始（満席・本走あり）」の卓id集合。交代チャンスの停止に使う。 */
function swapReadyTables(state: GameState): Set<number> {
  const ids = new Set<number>();
  for (const t of state.tables) {
    if (t.progress.status !== "WAITING_TO_START") continue;
    const full = t.seats.every((s) => s.occupant.kind !== "EMPTY");
    const honso = t.seats.some((s) => s.occupant.kind === "STAFF");
    if (full && honso) ids.add(t.id);
  }
  return ids;
}

export interface Engine {
  /** 次の判断イベントまで自動進行する。 */
  advance(): void;
  /** 進行中のアニメを止める（restart 用）。 */
  stop(): void;
}

interface Snapshot {
  waitingCount: number;
  urgentIds: Set<number>;
  tableStatus: Map<number, HanchanStatus>;
  swapReady: Set<number>;
}

/** tick 直前の状態を記録（イベント検出のため）。 */
export function snapshot(state: GameState): Snapshot {
  const urgentIds = new Set<number>();
  // 待ち列の客 + 開始待ちで着席中の客、どちらも緊急化を検出する。
  for (const c of state.waiting) {
    if (patienceRatio(c) > CONFIG.urgentRatio) urgentIds.add(c.id);
  }
  for (const c of seatedWaiting(state)) {
    if (patienceRatio(c) > CONFIG.urgentRatio) urgentIds.add(c.id);
  }
  const tableStatus = new Map<number, HanchanStatus>();
  for (const t of state.tables) tableStatus.set(t.id, t.progress.status);
  return {
    waitingCount: state.waiting.length,
    urgentIds,
    tableStatus,
    swapReady: swapReadyTables(state),
  };
}

/** 直前スナップショットと現在 state を比較し、判断が必要な停止イベントが起きたか。 */
export function detectStop(prev: Snapshot, state: GameState): boolean {
  // ① 閉店
  if (state.phase === "CLOSED") return true;
  // ② 新規来店
  if (state.waiting.length > prev.waitingCount) return true;
  // ③ 卓が新たに「開始待ち＋空席」に（半荘終了で席が空く＝案内/本走/合卓の判断）。
  //    継続中の開始待ちでは再停止しない（無意味な連続停止の回避）。
  for (const t of state.tables) {
    if (t.progress.status !== "WAITING_TO_START") continue;
    if (prev.tableStatus.get(t.id) === "WAITING_TO_START") continue;
    if (t.seats.some((s) => s.occupant.kind === "EMPTY")) return true;
  }
  // ④ 卓が新たに東場入り＋本走席あり＋待ち客あり（交代の機会）。
  if (state.waiting.length > 0) {
    for (const t of state.tables) {
      if (t.progress.status !== "EAST") continue;
      if (prev.tableStatus.get(t.id) === "EAST") continue;
      if (t.seats.some((s) => s.occupant.kind === "STAFF")) return true;
    }
    // ④' 卓が新たに「まもなく開始（満席・本走あり）」に＝開始前に本走を交代できる最後の機会。
    for (const id of swapReadyTables(state)) {
      if (!prev.swapReady.has(id)) return true;
    }
  }
  // ⑤ 待ち客 or 開始待ち着席客が新たに緊急化（離脱前の最後のチャンス）。
  for (const c of state.waiting) {
    if (!prev.urgentIds.has(c.id) && patienceRatio(c) > CONFIG.urgentRatio) return true;
  }
  for (const c of seatedWaiting(state)) {
    if (!prev.urgentIds.has(c.id) && patienceRatio(c) > CONFIG.urgentRatio) return true;
  }
  return false;
}

export function createEngine(state: GameState, onFrame: (state: GameState) => void): Engine {
  let rafId = 0;
  let last = 0;
  let acc = 0;

  const loop = (now: number) => {
    if (!state.advancing) return;
    const dt = last === 0 ? 0 : now - last;
    last = now;
    acc += dt;

    let stop = false;
    let steps = 0;
    while (acc >= CONFIG.advanceTickMs && steps < CONFIG.maxStepsPerFrame) {
      const prev = snapshot(state);
      tick(state);
      acc -= CONFIG.advanceTickMs;
      steps++;
      if (detectStop(prev, state)) {
        stop = true;
        break;
      }
    }

    onFrame(state);

    if (stop || state.phase === "CLOSED") {
      state.advancing = false;
      onFrame(state); // ボタンの disabled 解除を反映
      return;
    }
    rafId = requestAnimationFrame(loop);
  };

  return {
    advance() {
      if (state.advancing || state.phase === "CLOSED") return;
      state.advancing = true;
      last = 0;
      acc = 0;
      onFrame(state); // ボタンを「進行中…」disabled に
      rafId = requestAnimationFrame(loop);
    },
    stop() {
      state.advancing = false;
      if (rafId) cancelAnimationFrame(rafId);
    },
  };
}

/** 1tick（ゲーム内 minutesPerTick 分）進める。順序は決定的。 */
export function tick(state: GameState): void {
  const dt = CONFIG.minutesPerTick;
  // ① 時計
  state.clockMin += dt;

  // ①' 人件費の発生（営業中は店員数ぶんの時給が累積＝利益を圧迫）。
  if (state.phase !== "CLOSED") {
    state.expenses.wages += (state.staff.length * CONFIG.wagePerHourYen * dt) / 60;
  }

  // ② 閉店判定
  if (state.phase === "OPEN" && state.clockMin >= CONFIG.closeMin) {
    state.phase = "CLOSING";
    addLog(state, "INFO", "🔔 ラストオーダー。新規来店は締め切り、進行中の半荘は続行します");
  }

  // ③ 来店抽選（OPEN のみ）
  maybeSpawnArrival(state);

  // ④ 待ち更新＋怒り/時間切れ離席
  tickWaiting(state, dt);

  // ④' 開始待ちで着席中の客の待ち更新＋怒り離席
  tickSeatedWaiting(state, dt);

  // ⑤ 各卓の半荘進行
  // 配列が teardown で変化しうるのでコピーを回す。
  for (const table of [...state.tables]) {
    advanceHanchan(state, table, dt);
  }

  // ⑥ 閉店の最終判定: CLOSING で進行中の半荘が無い、または強制閉店時刻
  if (state.phase === "CLOSING") {
    const anyPlaying = state.tables.some(
      (t) => t.progress.status === "EAST" || t.progress.status === "SOUTH" || t.progress.status === "SETTLING",
    );
    if (!anyPlaying || state.clockMin >= CONFIG.hardCloseMin) {
      state.phase = "CLOSED";
      addLog(state, "INFO", "🏁 閉店しました。本日の営業終了。");
    }
  }
}
