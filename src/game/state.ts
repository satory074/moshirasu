// ===== 状態ファクトリ＆不変条件ヘルパー（ルールは持たない器）=====

import { CONFIG } from "./config";
import { staffName } from "./names";
import { createRng } from "./rng";
import type { GameState, LogEntry, LogKind, Staff } from "./types";

/** 初期状態を生成する。店員数は開店前設定で決め（既定 CONFIG.staffCount）、以降は変えない。 */
export function createInitialState(seed: number, staffCount: number = CONFIG.staffCount): GameState {
  const rng = createRng(seed);
  const staff: Staff[] = [];
  for (let i = 0; i < staffCount; i++) {
    staff.push({ id: i, name: staffName(i), busy: false });
  }
  return {
    seed,
    rng,
    clockMin: CONFIG.openMin,
    phase: "OPEN",
    advancing: false,
    tables: [],
    waiting: [],
    customers: new Map(),
    staff,
    revenue: { gameFee: 0, tips: 0, total: 0 },
    expenses: { wages: 0 },
    reputation: CONFIG.reputation.start,
    stats: {
      served: 0,
      hanchanPlayed: 0,
      rageQuits: 0,
      busts: 0,
      peakWaiting: 0,
      satisfied: 0,
      totalWaitMin: 0,
      waitSamples: 0,
    },
    eventLog: [],
    nextId: 1000, // 客/卓のID。店員は固定IDなので衝突しない領域から。
  };
}

/** 一意なIDを発番する。 */
export function nextId(state: GameState): number {
  return state.nextId++;
}

/** イベントログを追加する（新しい順・上限カット）。 */
export function addLog(state: GameState, kind: LogKind, text: string): void {
  const entry: LogEntry = {
    id: nextId(state),
    atMin: state.clockMin,
    kind,
    text,
  };
  state.eventLog.unshift(entry);
  if (state.eventLog.length > CONFIG.logCap) {
    state.eventLog.length = CONFIG.logCap;
  }
}

/** 評判を増減（範囲クランプ）。 */
export function adjustReputation(state: GameState, delta: number): void {
  state.reputation = Math.max(
    CONFIG.reputation.min,
    Math.min(CONFIG.reputation.max, state.reputation + delta),
  );
}

/** 売上を加算（合計も更新）。 */
export function addRevenue(state: GameState, gameFee: number, tips = 0): void {
  state.revenue.gameFee += gameFee;
  state.revenue.tips += tips;
  state.revenue.total = state.revenue.gameFee + state.revenue.tips;
}
