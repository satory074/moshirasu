// ===== プレイヤー命令層（UIはここ経由でしか state を変えない）=====

import { CONFIG } from "./config";
import { addLog, adjustReputation } from "./state";
import {
  attemptSwap,
  canCombine,
  combineTables,
  customerCount,
  firstEmptyIdx,
  freeStaff,
  hasEmptySeat,
  isFull,
  openTable,
  seatInto,
  tableNo,
} from "./tables";
import type { Customer, GameState, Occupant, Rate, Result } from "./types";

/** 待ち客IDから客を引く。 */
function getWaiting(state: GameState, id: number): Customer | undefined {
  return state.waiting.find((c) => c.id === id);
}

/** 客を着席させた後の共通処理。 */
function markSeated(state: GameState, c: Customer, tableId: number, seatIdx: number): void {
  c.seatRef = { tableId, seatIdx };
  c.status = "SEATED";
  c.waitedMin = 0;
  state.waiting = state.waiting.filter((w) => w.id !== c.id);
  state.stats.served++;
  adjustReputation(state, CONFIG.reputation.serveGain);
}

/**
 * 卓を立てる。指定した待ち客ID群（最大4）で新規卓を作る。
 * - レート希望と矛盾する客がいたら失敗
 * - 1人以上必要
 */
export function openTableAction(
  state: GameState,
  rate: Rate,
  customerIds: number[],
): Result {
  if (state.tables.length >= CONFIG.maxTables) {
    return { ok: false, reason: "卓数が上限です" };
  }
  const ids = customerIds.slice(0, 4);
  if (ids.length === 0) return { ok: false, reason: "客を選んでください" };

  const custs: Customer[] = [];
  for (const id of ids) {
    const c = getWaiting(state, id);
    if (!c) return { ok: false, reason: "選んだ客が見つかりません" };
    if (!prefAllows(c, rate)) {
      return { ok: false, reason: `${c.name} は${rate === "BLUE" ? "点5" : "点3"}を希望していません` };
    }
    custs.push(c);
  }

  const occ: Occupant[] = custs.map((c) => ({ kind: "CUSTOMER", customerId: c.id }));
  const table = openTable(state, rate, occ);
  custs.forEach((c, i) => markSeated(state, c, table.id, i));

  const no = tableNo(state, table);
  addLog(
    state,
    "OPEN",
    `🆕 卓#${no}（${rate === "BLUE" ? "ブルー(点5)" : "グリーン(点3)"}）を ${custs.length}人で用意`,
  );
  if (!isFull(table)) {
    addLog(state, "INFO", `卓#${no} はあと${4 - custs.length}人。本走か案内で埋めてください`);
  }
  return { ok: true };
}

/** 既存卓の空席に待ち客を案内する。 */
export function seatCustomerAction(
  state: GameState,
  customerId: number,
  tableId: number,
): Result {
  const table = state.tables.find((t) => t.id === tableId);
  if (!table) return { ok: false, reason: "卓が見つかりません" };
  if (!hasEmptySeat(table)) return { ok: false, reason: "空席がありません" };
  if (table.progress.status !== "WAITING_TO_START") {
    return { ok: false, reason: "対局中の卓には案内できません（交代を使ってください）" };
  }
  const c = getWaiting(state, customerId);
  if (!c) return { ok: false, reason: "客が見つかりません" };
  if (!prefAllows(c, table.rate)) {
    return { ok: false, reason: `${c.name} は${table.rate === "BLUE" ? "点5" : "点3"}を希望していません` };
  }
  const idx = seatInto(table, { kind: "CUSTOMER", customerId: c.id });
  if (idx < 0) return { ok: false, reason: "着席に失敗しました" };
  markSeated(state, c, table.id, idx);
  addLog(state, "SEAT", `🪑 ${c.name} を卓#${tableNo(state, table)} に案内`);
  return { ok: true };
}

/** 本走: 空いている店員を卓の空席に入れる。 */
export function honsoAction(state: GameState, tableId: number): Result {
  const table = state.tables.find((t) => t.id === tableId);
  if (!table) return { ok: false, reason: "卓が見つかりません" };
  if (!hasEmptySeat(table)) return { ok: false, reason: "空席がありません" };
  if (table.progress.status !== "WAITING_TO_START") {
    return { ok: false, reason: "対局中の卓には本走で入れません" };
  }
  if (customerCount(table) === 0) {
    return { ok: false, reason: "客が1人もいない卓には本走しません" };
  }
  const st = freeStaff(state);
  if (!st) return { ok: false, reason: "空いている店員がいません" };
  const idx = seatInto(table, { kind: "STAFF", staffId: st.id });
  if (idx < 0) return { ok: false, reason: "着席に失敗しました" };
  st.busy = true;
  addLog(state, "HONSO", `🧑‍💼 ${st.name} が卓#${tableNo(state, table)} に本走で入った`);
  return { ok: true };
}

/** 交代: 待ち客が対局中卓の本走席と交代を試みる（東場のみ・確率受諾）。 */
export function swapAction(
  state: GameState,
  customerId: number,
  tableId: number,
): Result {
  const table = state.tables.find((t) => t.id === tableId);
  if (!table) return { ok: false, reason: "卓が見つかりません" };
  const c = getWaiting(state, customerId);
  if (!c) return { ok: false, reason: "客が見つかりません" };
  if (!prefAllows(c, table.rate)) {
    return { ok: false, reason: `${c.name} は${table.rate === "BLUE" ? "点5" : "点3"}を希望していません` };
  }
  const res = attemptSwap(state, table, c);
  if (!res.ok) {
    return { ok: false, reason: "今は交代できません（東場の本走席のみ）" };
  }
  const no = tableNo(state, table);
  if (res.accepted) {
    addLog(state, "SWAP", `🔄 ${c.name} が卓#${no} の本走と交代（点棒・親に納得）`);
    return { ok: true };
  }
  addLog(state, "SWAP", `🙅 ${c.name} は卓#${no} の状況に納得せず交代を見送り`);
  return { ok: false, reason: `${c.name} は点棒・親状況に納得しませんでした` };
}

/** 合卓: 2卓の客を1卓に集約し本走店員を解放する。 */
export function combineAction(state: GameState, tableIdA: number, tableIdB: number): Result {
  const a = state.tables.find((t) => t.id === tableIdA);
  const b = state.tables.find((t) => t.id === tableIdB);
  if (!a || !b) return { ok: false, reason: "卓が見つかりません" };
  if (!canCombine(a, b)) {
    return {
      ok: false,
      reason: "合卓不可（同レート・半荘前・客合計4人以下が条件）",
    };
  }
  // 客が多い方を残す
  const [keep, drop] = customerCount(a) >= customerCount(b) ? [a, b] : [b, a];
  const result = combineTables(state, keep, drop);
  const no = tableNo(state, result);
  addLog(state, "COMBINE", `🔗 卓を合卓して卓#${no} に集約（本走を解放）`);
  if (firstEmptyIdx(result) >= 0) {
    addLog(state, "INFO", `卓#${no} はあと${4 - occupiedCount(result)}人。案内/本走で埋めてください`);
  }
  return { ok: true };
}

// ---- ヘルパー ----

function prefAllows(c: Customer, rate: Rate): boolean {
  return c.pref === "ANY" || c.pref === rate;
}

function occupiedCount(table: { seats: { occupant: { kind: string } }[] }): number {
  return table.seats.filter((s) => s.occupant.kind !== "EMPTY").length;
}
