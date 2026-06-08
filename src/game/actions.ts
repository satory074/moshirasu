// ===== プレイヤー命令層（UIはここ経由でしか state を変えない）=====

import { CONFIG } from "./config";
import { addLog, adjustReputation } from "./state";
import {
  attemptSwap,
  canChangeRate,
  canCombine,
  combineTables,
  customerCount,
  firstEmptyIdx,
  isFull,
  openTable,
  tableNo,
  teardownTable,
} from "./tables";
import type { Customer, GameState, Occupant, Rate, Result, Table } from "./types";

/** 待ち客IDから客を引く。 */
function getWaiting(state: GameState, id: number): Customer | undefined {
  return state.waiting.find((c) => c.id === id);
}

/** 客を着席させた後の共通処理。 */
function markSeated(state: GameState, c: Customer, tableId: number, seatIdx: number): void {
  c.seatRef = { tableId, seatIdx };
  c.status = "SEATED";
  // waitedMin はリセットしない。半荘が実際に始まる（→東場）まで「開始待ち」として
  // カウントを継続する（tables.startHanchan で開始時に 0 へ戻す）。
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

/** 既存卓の指定空席に待ち客を案内する。 */
export function seatCustomerAction(
  state: GameState,
  customerId: number,
  tableId: number,
  seatIdx: number,
): Result {
  const table = state.tables.find((t) => t.id === tableId);
  if (!table) return { ok: false, reason: "卓が見つかりません" };
  if (table.progress.status !== "WAITING_TO_START") {
    return { ok: false, reason: "対局中の卓には案内できません（交代を使ってください）" };
  }
  const seat = table.seats[seatIdx];
  if (!seat || seat.occupant.kind !== "EMPTY") {
    return { ok: false, reason: "その席は空いていません" };
  }
  const c = getWaiting(state, customerId);
  if (!c) return { ok: false, reason: "客が見つかりません" };
  if (!prefAllows(c, table.rate)) {
    return { ok: false, reason: `${c.name} は${table.rate === "BLUE" ? "点5" : "点3"}を希望していません` };
  }
  seat.occupant = { kind: "CUSTOMER", customerId: c.id };
  markSeated(state, c, table.id, seatIdx);
  addLog(state, "SEAT", `🪑 ${c.name} を卓#${tableNo(state, table)} に案内`);
  return { ok: true };
}

/** 本走: 指定の空き店員を卓の指定空席に入れる。 */
export function honsoAction(
  state: GameState,
  tableId: number,
  seatIdx: number,
  staffId: number,
): Result {
  const table = state.tables.find((t) => t.id === tableId);
  if (!table) return { ok: false, reason: "卓が見つかりません" };
  if (table.progress.status !== "WAITING_TO_START") {
    return { ok: false, reason: "対局中の卓には本走で入れません" };
  }
  const seat = table.seats[seatIdx];
  if (!seat || seat.occupant.kind !== "EMPTY") {
    return { ok: false, reason: "その席は空いていません" };
  }
  if (customerCount(table) === 0) {
    return { ok: false, reason: "客が1人もいない卓には本走しません" };
  }
  const st = state.staff.find((s) => s.id === staffId && !s.busy);
  if (!st) return { ok: false, reason: "その店員は入れません" };
  seat.occupant = { kind: "STAFF", staffId: st.id };
  st.busy = true;
  addLog(state, "HONSO", `🧑‍💼 ${st.name} が卓#${tableNo(state, table)} に本走で入った`);
  return { ok: true };
}

/** 交代: 待ち客が本走席と交代を試みる（開始待ち/東場・確率受諾）。 */
export function swapAction(
  state: GameState,
  customerId: number,
  tableId: number,
  seatIdx: number,
): Result {
  const table = state.tables.find((t) => t.id === tableId);
  if (!table) return { ok: false, reason: "卓が見つかりません" };
  const c = getWaiting(state, customerId);
  if (!c) return { ok: false, reason: "客が見つかりません" };
  if (c.refusedTables.includes(tableId)) {
    return { ok: false, reason: `${c.name} はこの卓への交代を既に断っています` };
  }
  if (!prefAllows(c, table.rate)) {
    return { ok: false, reason: `${c.name} は${table.rate === "BLUE" ? "点5" : "点3"}を希望していません` };
  }
  const res = attemptSwap(state, table, c, seatIdx);
  if (!res.ok) {
    return { ok: false, reason: "今は交代できません（開始待ち/東場の本走席のみ）" };
  }
  const no = tableNo(state, table);
  if (res.accepted) {
    addLog(state, "SWAP", `🔄 ${c.name} が卓#${no} の本走と交代（点棒・親に納得）`);
    return { ok: true };
  }
  addLog(state, "SWAP", `🙅 ${c.name} は卓#${no} の状況に納得せず交代を見送り`);
  return { ok: false, reason: `${c.name} は点棒・親状況に納得しませんでした` };
}

/**
 * 移動: 着席中（半荘前）の客を、希望が一致する別の半荘前卓の空席へ移す。
 * 元卓が空になったら撤去する。
 */
export function moveCustomerAction(
  state: GameState,
  customerId: number,
  destTableId: number,
  destSeatIdx: number,
): Result {
  const c = state.customers.get(customerId);
  if (!c || c.status !== "SEATED" || !c.seatRef) {
    return { ok: false, reason: "移動できる客ではありません" };
  }
  const source = state.tables.find((t) => t.id === c.seatRef!.tableId);
  if (!source) return { ok: false, reason: "元の卓が見つかりません" };
  if (source.progress.status !== "WAITING_TO_START") {
    return { ok: false, reason: "対局中の卓からは移動できません" };
  }
  const dest = state.tables.find((t) => t.id === destTableId);
  if (!dest) return { ok: false, reason: "移動先の卓が見つかりません" };
  if (dest.id === source.id) return { ok: false, reason: "同じ卓です" };
  if (dest.progress.status !== "WAITING_TO_START") {
    return { ok: false, reason: "対局中の卓へは移動できません" };
  }
  const destSeat = dest.seats[destSeatIdx];
  if (!destSeat || destSeat.occupant.kind !== "EMPTY") {
    return { ok: false, reason: "その席は空いていません" };
  }
  if (!prefAllows(c, dest.rate)) {
    return { ok: false, reason: `${c.name} は${dest.rate === "BLUE" ? "点5" : "点3"}を希望していません` };
  }

  // 元席を空ける（参照は付け替えるので seatRef は解除しない）。
  const src = source.seats[c.seatRef.seatIdx];
  src.occupant = { kind: "EMPTY" };
  src.call = undefined;
  src.points = CONFIG.oka.mochi;

  destSeat.occupant = { kind: "CUSTOMER", customerId: c.id };
  c.seatRef = { tableId: dest.id, seatIdx: destSeatIdx };

  const destNo = tableNo(state, dest);
  addLog(state, "SEAT", `↪️ ${c.name} を卓#${destNo} へ移動`);

  // 元卓に客が残らなければ撤去（店員も解放）。
  if (customerCount(source) === 0) {
    teardownTable(state, source);
  }
  return { ok: true };
}

/** 合卓: 2卓の客を1卓に集約し本走店員を解放する。レートは客の希望が両立する側へ寄せる。 */
export function combineAction(state: GameState, tableIdA: number, tableIdB: number): Result {
  const a = state.tables.find((t) => t.id === tableIdA);
  const b = state.tables.find((t) => t.id === tableIdB);
  if (!a || !b) return { ok: false, reason: "卓が見つかりません" };
  if (!canCombine(a, b)) {
    return { ok: false, reason: "合卓不可（半荘前・客合計4人以下が条件）" };
  }
  // 両卓の客の希望を両立できるレートを決める（できなければ不可）。
  const custs = [...customersOnTable(state, a), ...customersOnTable(state, b)];
  const rate = combineRate(custs, a.rate, b.rate);
  if (!rate) {
    return { ok: false, reason: "点5希望と点3希望の客が混在しており合卓できません" };
  }
  // 採用レートを持つ卓を残す（両方/どちらも該当なら客が多い方を残し、そのレートに変更）。
  let keep: Table;
  let drop: Table;
  if (a.rate === rate && b.rate !== rate) {
    keep = a;
    drop = b;
  } else if (b.rate === rate && a.rate !== rate) {
    keep = b;
    drop = a;
  } else {
    [keep, drop] = customerCount(a) >= customerCount(b) ? [a, b] : [b, a];
    keep.rate = rate; // 半荘前なので安全に変更できる
  }
  const result = combineTables(state, keep, drop);
  const no = tableNo(state, result);
  addLog(
    state,
    "COMBINE",
    `🔗 卓を合卓して卓#${no}（${rate === "BLUE" ? "点5" : "点3"}）に集約（本走を解放）`,
  );
  if (firstEmptyIdx(result) >= 0) {
    addLog(state, "INFO", `卓#${no} はあと${4 - occupiedCount(result)}人。案内/本走で埋めてください`);
  }
  return { ok: true };
}

/** レート変更: 客が全員「どちらでも」の半荘前卓のレートを切り替える（点5⇄点3）。 */
export function changeRateAction(state: GameState, tableId: number): Result {
  const table = state.tables.find((t) => t.id === tableId);
  if (!table) return { ok: false, reason: "卓が見つかりません" };
  if (!canChangeRate(state, table)) {
    return { ok: false, reason: "レート変更不可（半荘前・客が全員『どちらでも』の卓のみ）" };
  }
  table.rate = table.rate === "BLUE" ? "GREEN" : "BLUE";
  addLog(
    state,
    "OPEN",
    `🔁 卓#${tableNo(state, table)} のレートを ${table.rate === "BLUE" ? "点5(ブルー)" : "点3(グリーン)"} に変更`,
  );
  return { ok: true };
}

// ---- ヘルパー ----

function prefAllows(c: Customer, rate: Rate): boolean {
  return c.pref === "ANY" || c.pref === rate;
}

/** 卓に着席中の客一覧。 */
function customersOnTable(state: GameState, table: Table): Customer[] {
  const out: Customer[] = [];
  for (const seat of table.seats) {
    if (seat.occupant.kind !== "CUSTOMER") continue;
    const c = state.customers.get(seat.occupant.customerId);
    if (c) out.push(c);
  }
  return out;
}

/**
 * 合卓後のレートを決める。全客の希望を両立するレートを返す（無ければ null）。
 * 既存卓が持つレート（ra/rb）を優先し、レート変更を避ける。
 */
function combineRate(custs: Customer[], ra: Rate, rb: Rate): Rate | null {
  const ok = (r: Rate) => custs.every((c) => c.pref === "ANY" || c.pref === r);
  const blueOk = ok("BLUE");
  const greenOk = ok("GREEN");
  for (const r of [ra, rb]) {
    if (r === "BLUE" && blueOk) return "BLUE";
    if (r === "GREEN" && greenOk) return "GREEN";
  }
  return blueOk ? "BLUE" : greenOk ? "GREEN" : null;
}

function occupiedCount(table: { seats: { occupant: { kind: string } }[] }): number {
  return table.seats.filter((s) => s.occupant.kind !== "EMPTY").length;
}
