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
  wages: number;
  profit: number;
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
  const wages = state.expenses.wages;
  return {
    revenue: state.revenue.total,
    wages,
    profit: state.revenue.total - wages,
    served: state.stats.served,
    waiting: state.waiting.length,
    tables: state.tables.length,
    avgWait,
    rageQuits: state.stats.rageQuits,
    busts: state.stats.busts,
  };
}

/** 局ラベル（例: 「東2局」「南4局 1本場」）。対局中以外は空文字。 */
export function kyokuLabel(table: Table): string {
  const p = table.progress;
  if (p.status !== "EAST" && p.status !== "SOUTH") return "";
  const ba = p.status === "EAST" ? "東" : "南";
  const honba = p.honba > 0 ? ` ${p.honba}本場` : "";
  return `${ba}${p.kyoku}局${honba}`;
}

/** 閉店したか。 */
export function isClosed(state: GameState): boolean {
  return state.phase === "CLOSED";
}

/** 半荘の進行 0..1（標準8局＝東1〜南4を目安にした経過）。 */
export function hanchanProgress(table: Table): number {
  if (table.progress.status === "WAITING_TO_START") return 0;
  if (table.progress.status === "SETTLING" || table.progress.status === "DONE") return 1;
  const total = 8 * CONFIG.kyoku.kyokuMin; // 標準8局ぶんの目安時間
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
