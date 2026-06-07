// ===== 描画用の派生・読取専用ビュー（render を dumb に保つ）=====

import { CONFIG } from "./config";
import type { Customer, GameState, Table } from "./types";

/** 分 → "HH:MM"。 */
export function formatClock(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = Math.floor(min % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 円表示。 */
export function yen(n: number): string {
  return `¥${Math.round(n).toLocaleString()}`;
}

/** 営業の進捗 0..1。 */
export function dayProgress(state: GameState): number {
  const total = CONFIG.hardCloseMin - CONFIG.openMin;
  return Math.max(0, Math.min(1, (state.clockMin - CONFIG.openMin) / total));
}

/** 主要KPI。 */
export function kpis(state: GameState): {
  revenue: number;
  served: number;
  waiting: number;
  tables: number;
  avgWait: number;
  rageQuits: number;
  busts: number;
} {
  const avgWait =
    state.stats.waitSamples > 0
      ? state.stats.totalWaitMin / state.stats.waitSamples
      : 0;
  return {
    revenue: state.revenue.total,
    served: state.stats.served,
    waiting: state.waiting.length,
    tables: state.tables.length,
    avgWait,
    rageQuits: state.stats.rageQuits,
    busts: state.stats.busts,
  };
}

/** 閉店したか。 */
export function isClosed(state: GameState): boolean {
  return state.phase === "CLOSED";
}

/** 半荘の進行 0..1（東+南）。 */
export function hanchanProgress(table: Table): number {
  const total = CONFIG.eastMin + CONFIG.southMin;
  if (table.progress.status === "WAITING_TO_START") return 0;
  if (table.progress.status === "SETTLING" || table.progress.status === "DONE") return 1;
  return Math.max(0, Math.min(1, table.progress.elapsedMin / total));
}

/** 待ち客の我慢ゲージ 0..1（1=限界）。 */
export function patienceRatio(c: Customer): number {
  return Math.max(0, Math.min(1, c.waitedMin / c.patienceMin));
}

/** 帰宅まで何分か。 */
export function minsUntilLeave(state: GameState, c: Customer): number {
  return Math.max(0, Math.round(c.leaveByMin - state.clockMin));
}
