// ===== 卓・席・半荘進行の中核 =====

import { CONFIG } from "./config";
import { decideLeaveOrStay } from "./customers";
import {
  applyBankroll,
  collectGameFee,
  settleHanchan,
} from "./economy";
import {
  addLog,
  addRevenue,
  adjustReputation,
  nextId,
} from "./state";
import type {
  Customer,
  GameState,
  Occupant,
  Rate,
  Seat,
  Staff,
  Table,
} from "./types";

/** 空席を作る。 */
export function emptySeat(): Seat {
  return { occupant: { kind: "EMPTY" }, points: CONFIG.oka.mochi, isDealer: false };
}

/** 新しい卓を立てる（占有者を順に着席）。 */
export function openTable(
  state: GameState,
  rate: Rate,
  occupants: Occupant[],
): Table {
  const seats: Seat[] = [emptySeat(), emptySeat(), emptySeat(), emptySeat()];
  occupants.slice(0, 4).forEach((occ, i) => {
    seats[i] = { occupant: occ, points: CONFIG.oka.mochi, isDealer: i === 0 };
  });
  const table: Table = {
    id: nextId(state),
    rate,
    seats: seats as [Seat, Seat, Seat, Seat],
    progress: { status: "WAITING_TO_START", elapsedMin: 0, hanchanCount: 0 },
    openedAtMin: state.clockMin,
  };
  state.tables.push(table);
  return table;
}

/** 卓に空席があるか。 */
export function hasEmptySeat(table: Table): boolean {
  return table.seats.some((s) => s.occupant.kind === "EMPTY");
}

/** 卓が満席か。 */
export function isFull(table: Table): boolean {
  return table.seats.every((s) => s.occupant.kind !== "EMPTY");
}

/** 卓の客人数。 */
export function customerCount(table: Table): number {
  return table.seats.filter((s) => s.occupant.kind === "CUSTOMER").length;
}

/** 卓の本走（店員）席があるか。 */
export function hasHonso(table: Table): boolean {
  return table.seats.some((s) => s.occupant.kind === "STAFF");
}

/** 最初の空席インデックス（無ければ -1）。 */
export function firstEmptyIdx(table: Table): number {
  return table.seats.findIndex((s) => s.occupant.kind === "EMPTY");
}

/** 占有者を空席に着ける。成功で席index、失敗で -1。 */
export function seatInto(table: Table, occupant: Occupant): number {
  const idx = firstEmptyIdx(table);
  if (idx < 0) return -1;
  table.seats[idx].occupant = occupant;
  return idx;
}

/**
 * 半荘開始時のコールを各客席に設定する。
 * ラスハン or モシラス。帰宅間近・資金薄でラスハン率↑。
 */
export function rollCalls(state: GameState): (table: Table) => void {
  return (table: Table) => {
    for (const seat of table.seats) {
      if (seat.occupant.kind !== "CUSTOMER") {
        seat.call = undefined;
        continue;
      }
      const c = state.customers.get(seat.occupant.customerId);
      if (!c) {
        seat.call = undefined;
        continue;
      }
      let pLasthan: number = CONFIG.baseLasthanProb;
      const minsLeft = c.leaveByMin - state.clockMin;
      // この半荘ぶん(東+南)を打つと帰宅時刻を超える → ラスハン濃厚
      if (minsLeft <= CONFIG.eastMin + CONFIG.southMin) pLasthan = 0.95;
      else if (minsLeft <= CONFIG.callLasthanBias.nearLeaveByMin)
        pLasthan += CONFIG.callLasthanBias.nearLeaveByBoost;
      const ratio = c.bankroll / Math.max(1, c.startBankroll);
      if (ratio <= CONFIG.callLasthanBias.lowBankrollRatio)
        pLasthan += CONFIG.callLasthanBias.lowBankrollBoost;
      seat.call = state.rng.chance(pLasthan) ? "LASTHAN" : "MOSHIRASU";
    }
  };
}

/**
 * 卓の半荘進行を dtMin ぶん進める。
 * WAITING_TO_START → (満席なら) コール→東場 → 南場 → 精算 → 次半荘へ
 */
export function advanceHanchan(state: GameState, table: Table, dtMin: number): void {
  const p = table.progress;
  switch (p.status) {
    case "WAITING_TO_START": {
      if (isFull(table)) {
        rollCalls(state)(table);
        p.status = "EAST";
        p.elapsedMin = 0;
        addLog(
          state,
          "OPEN",
          `🀄 卓#${tableNo(state, table)}（${table.rate === "BLUE" ? "点5" : "点3"}）東場開始`,
        );
      }
      break;
    }
    case "EAST": {
      p.elapsedMin += dtMin;
      // 半荘中、点棒を少しずつ揺らす（交代受諾判定に効く）。
      driftPoints(state, table);
      if (p.elapsedMin >= CONFIG.eastMin) {
        p.status = "SOUTH";
      }
      break;
    }
    case "SOUTH": {
      p.elapsedMin += dtMin;
      driftPoints(state, table);
      if (p.elapsedMin >= CONFIG.eastMin + CONFIG.southMin) {
        p.status = "SETTLING";
      }
      break;
    }
    case "SETTLING": {
      settleTable(state, table);
      // 次の半荘へ。卓に客が1人もいなければ卓を畳む。
      if (customerCount(table) === 0) {
        teardownTable(state, table);
      } else {
        p.status = "WAITING_TO_START";
        p.elapsedMin = 0;
        p.hanchanCount++;
      }
      break;
    }
    case "DONE":
      break;
  }
}

/** 精算1tick: 場代徴収 + 着順精算 + 去就判定。 */
function settleTable(state: GameState, table: Table): void {
  // --- 場代（プレイヤー売上）---
  const fee = collectGameFee(table);
  addRevenue(state, fee);
  for (const seat of table.seats) {
    if (seat.occupant.kind === "CUSTOMER") {
      const c = state.customers.get(seat.occupant.customerId);
      if (c) c.feePaid += CONFIG.gameFeeYen[table.rate];
    }
  }
  state.stats.hanchanPlayed++;

  // --- 着順精算（客の資金増減）---
  const result = settleHanchan(table, state.customers, state.rng);
  const no = tableNo(state, table);
  let topName = "";
  for (const s of result.seats) {
    const seat = table.seats[s.seatIdx];
    if (seat.occupant.kind !== "CUSTOMER") continue;
    const c = state.customers.get(seat.occupant.customerId);
    if (!c) continue;
    if (s.rank === 1) topName = c.name;
    const { busted } = applyBankroll(c, s.yen);
    // ツキを軽くドリフト（平均回帰）。
    c.luck = clampLuck(c.luck + state.rng.gaussian(0, CONFIG.luck.driftSd));

    // 去就判定
    const decision = decideLeaveOrStay(state, c, seat, busted);
    if (decision.leaves) {
      removeFromSeat(state, table, s.seatIdx);
      c.status = "LEFT";
      if (decision.reason === "BUST") {
        state.stats.busts++;
        adjustReputation(state, -CONFIG.reputation.bustHit);
        addLog(state, "BUST", `💸 ${c.name} が飛んで離席（卓#${no}）`);
      } else {
        state.stats.satisfied++;
        adjustReputation(state, CONFIG.reputation.satisfiedGain);
        const why =
          decision.reason === "LASTHAN"
            ? "ラスハン"
            : decision.reason === "TIMEUP"
              ? "時間"
              : "モシラス→終了";
        addLog(state, "LEAVE", `👋 ${c.name} が${why}で離席（卓#${no}）`);
      }
    } else {
      // 続行。点棒リセット（次半荘）。
      seat.points = CONFIG.oka.mochi;
      seat.call = undefined;
    }
  }

  // 本走（店員）席もリセット。店員は飛ばない。
  for (let i = 0; i < 4; i++) {
    const seat = table.seats[i];
    if (seat.occupant.kind === "STAFF") {
      seat.points = CONFIG.oka.mochi;
      seat.call = undefined;
    }
  }

  if (fee > 0) {
    addLog(
      state,
      "SETTLE",
      `💰 卓#${no} 半荘終了 場代+¥${fee.toLocaleString()}${topName ? `（トップ: ${topName}）` : ""}`,
    );
  }
}

/** 卓を畳む（本走店員を解放）。 */
export function teardownTable(state: GameState, table: Table): void {
  releaseStaffOf(state, table);
  state.tables = state.tables.filter((t) => t.id !== table.id);
}

/** 席から占有者を外す（客なら参照解除、店員なら解放）。 */
export function removeFromSeat(state: GameState, table: Table, seatIdx: number): void {
  const seat = table.seats[seatIdx];
  if (seat.occupant.kind === "STAFF") {
    const st = state.staff.find((s) => s.id === (seat.occupant as { staffId: number }).staffId);
    if (st) st.busy = false;
  } else if (seat.occupant.kind === "CUSTOMER") {
    const c = state.customers.get(seat.occupant.customerId);
    if (c) c.seatRef = undefined;
  }
  seat.occupant = { kind: "EMPTY" };
  seat.call = undefined;
  seat.points = CONFIG.oka.mochi;
}

/** 卓上の全店員を解放。 */
function releaseStaffOf(state: GameState, table: Table): void {
  for (const seat of table.seats) {
    if (seat.occupant.kind === "STAFF") {
      const st = state.staff.find((s) => s.id === (seat.occupant as { staffId: number }).staffId);
      if (st) st.busy = false;
    }
  }
}

/** 空いている店員を1人返す（無ければ undefined）。 */
export function freeStaff(state: GameState): Staff | undefined {
  return state.staff.find((s) => !s.busy);
}

/**
 * 交代可能か: 東場の間 かつ 本走席がある。
 */
export function canSwapHonso(table: Table): boolean {
  return table.progress.status === "EAST" && hasHonso(table);
}

/**
 * 客が本走席と交代を試みる。点棒リード・親で受諾↑、帰宅間近で受諾↓。
 * 成功なら客を着席・店員を解放して true。
 */
export function attemptSwap(
  state: GameState,
  table: Table,
  customer: Customer,
): { ok: boolean; accepted: boolean } {
  if (!canSwapHonso(table)) return { ok: false, accepted: false };
  const idx = table.seats.findIndex((s) => s.occupant.kind === "STAFF");
  if (idx < 0) return { ok: false, accepted: false };
  const seat = table.seats[idx];

  // 受諾確率
  let p: number = CONFIG.swap.base;
  p += (seat.points - CONFIG.oka.mochi) * CONFIG.swap.kPoints; // 点棒リードで上昇
  if (seat.isDealer) p += CONFIG.swap.dealerBonus; // 親番は美味しい
  const minsLeft = customer.leaveByMin - state.clockMin;
  p -= Math.max(0, (60 - minsLeft)) * CONFIG.swap.kLateMin; // 帰宅間近だと渋る
  p = Math.max(0.05, Math.min(0.95, p));

  if (!state.rng.chance(p)) {
    return { ok: true, accepted: false };
  }

  // 受諾 → 店員を外して客を着ける
  const st = state.staff.find((s) => s.id === (seat.occupant as { staffId: number }).staffId);
  if (st) st.busy = false;
  seat.occupant = { kind: "CUSTOMER", customerId: customer.id };
  customer.seatRef = { tableId: table.id, seatIdx: idx };
  customer.status = "SEATED";
  customer.waitedMin = 0;
  state.waiting = state.waiting.filter((c) => c.id !== customer.id);
  state.stats.served++;
  adjustReputation(state, CONFIG.reputation.serveGain);
  return { ok: true, accepted: true };
}

/**
 * 2卓を合卓できるか。
 * - 両方とも WAITING_TO_START（半荘前）
 * - 同レート
 * - 合計の「客＋本走」占有が4以下で、本走を外せば客だけで埋まる見込み
 * 実用上は「客の合計が4以下」を条件に、客を1卓へ集約し本走を解放する。
 */
export function canCombine(a: Table, b: Table): boolean {
  if (a.id === b.id) return false;
  if (a.progress.status !== "WAITING_TO_START") return false;
  if (b.progress.status !== "WAITING_TO_START") return false;
  if (a.rate !== b.rate) return false;
  const totalCustomers = customerCount(a) + customerCount(b);
  return totalCustomers >= 1 && totalCustomers <= 4;
}

/**
 * b の客を a に集約し、b を畳む。足りなければ本走で埋める（任意）。
 * 戻り値: 集約後の卓 a。
 */
export function combineTables(state: GameState, a: Table, b: Table): Table {
  // b の客を集める
  const movers: number[] = [];
  for (const seat of b.seats) {
    if (seat.occupant.kind === "CUSTOMER") movers.push(seat.occupant.customerId);
  }
  // b を畳む（席はまだ参照されているので、客参照だけ移す前に占有解除）
  for (let i = 0; i < 4; i++) {
    const seat = b.seats[i];
    if (seat.occupant.kind === "STAFF") {
      const st = state.staff.find((s) => s.id === (seat.occupant as { staffId: number }).staffId);
      if (st) st.busy = false;
    }
    seat.occupant = { kind: "EMPTY" };
  }
  state.tables = state.tables.filter((t) => t.id !== b.id);

  // a の本走席を外して客の余地を作る（合卓の主目的＝店員解放）
  for (let i = 0; i < 4; i++) {
    const seat = a.seats[i];
    if (seat.occupant.kind === "STAFF") {
      const st = state.staff.find((s) => s.id === (seat.occupant as { staffId: number }).staffId);
      if (st) st.busy = false;
      seat.occupant = { kind: "EMPTY" };
    }
  }

  // 客を a の空席へ
  for (const cid of movers) {
    const idx = firstEmptyIdx(a);
    if (idx < 0) break;
    a.seats[idx].occupant = { kind: "CUSTOMER", customerId: cid };
    const c = state.customers.get(cid);
    if (c) c.seatRef = { tableId: a.id, seatIdx: idx };
  }
  return a;
}

/** 卓の表示番号（配列内の位置+1）。 */
export function tableNo(state: GameState, table: Table): number {
  return state.tables.findIndex((t) => t.id === table.id) + 1;
}

// ---- 内部 ----

/** 半荘中に各席の点棒を緩く揺らす（交代受諾の見栄えに使う）。 */
function driftPoints(state: GameState, table: Table): void {
  for (const seat of table.seats) {
    if (seat.occupant.kind === "EMPTY") continue;
    seat.points += Math.round(state.rng.gaussian(0, 1500));
  }
}

function clampLuck(x: number): number {
  return Math.max(0.05, Math.min(0.95, x));
}
