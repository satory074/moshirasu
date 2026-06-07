// ===== 経済・精算数式（純関数）=====
// プレイヤーの売上 = 場代（客席のみ）。
// 客の資金 = 半荘ごとの着順精算（オカ/ウマ/祝儀）で増減。

import { CONFIG } from "./config";
import type { Rng } from "./rng";
import type { Customer, Rate, Table } from "./types";

/** 1座席ぶんの精算結果。 */
export interface SeatSettlement {
  seatIdx: number;
  /** 着順 1..4。 */
  rank: number;
  /** 円での収支（祝儀込み）。 */
  yen: number;
  /** うち祝儀ぶん（点5のみ）。 */
  tipYen: number;
}

/** 卓1半荘ぶんの精算結果。 */
export interface SettlementResult {
  seats: SeatSettlement[];
}

/**
 * 場代を計算する。客席のみ徴収、本走（STAFF）席は0。
 * これがプレイヤーの実売上。
 */
export function collectGameFee(table: Table): number {
  const fee = CONFIG.gameFeeYen[table.rate];
  let total = 0;
  for (const seat of table.seats) {
    if (seat.occupant.kind === "CUSTOMER") total += fee;
  }
  return total;
}

/**
 * 半荘を精算する（局シミュで累積した「実点棒」を入力にする）。
 * 1. 実点棒の降順で着順1..4を決定（同点は起家=席順で上位）
 * 2. 素点 = (点棒 − 30000返し)/1000、オカ(+20000を1位総取り)・ウマを適用
 *    → 合計はゼロサム（点棒合計100000が前提）
 * 3. レートで円換算、点5は祝儀を加算（祝儀もゼロサム）
 *
 * customers は将来用に残す（現状この関数では未使用）。
 */
export function settleHanchan(
  table: Table,
  customers: Map<number, Customer>,
  rng: Rng,
): SettlementResult {
  void customers;
  // --- 実点棒で着順決定（同点は席index昇順=起家優先）---
  const order = table.seats.map((seat, seatIdx) => ({ seatIdx, points: seat.points }));
  order.sort((a, b) => b.points - a.points || a.seatIdx - b.seatIdx);
  const rankBySeat = new Array<number>(4);
  order.forEach((o, i) => {
    rankBySeat[o.seatIdx] = i + 1; // 1..4
  });

  // --- 祝儀（点5のみ・ゼロサム）---
  // 現実同様、下位が上位に祝儀を支払う。点5の振れ幅を増やし、
  // 薄い資金の客は大敗で飛びうる（高レートのリスク）。
  const tipNetByRank = [0, 0, 0, 0]; // 着順index → 円（+受取/−支払）
  if (table.rate === "BLUE") {
    const volume = poissonish(CONFIG.tipMeanByRank[0] + 0.5, rng);
    const totalTipYen = volume * CONFIG.tipYen;
    const share = [0.6, 0.15, -0.25, -0.5];
    for (let r = 0; r < 4; r++) tipNetByRank[r] = Math.round(totalTipYen * share[r]);
    const drift = tipNetByRank.reduce((a, b) => a + b, 0);
    tipNetByRank[0] -= drift;
  }

  // --- オカ・ウマ・円換算 ---
  // 素点合計 = (Σ点棒 − 4×返し)/1000 = (100000 − 120000)/1000 = −20。
  // 1位に +オカ(20) を乗せて合計0、ウマ[+20,+10,−10,−20]も合計0。
  const okaPer1000 = ((CONFIG.oka.kaeshi - CONFIG.oka.mochi) / 1000) * 4; // 20
  const yenPer1000 = CONFIG.rateYenPer1000[table.rate];
  const seats: SeatSettlement[] = table.seats.map((seat, seatIdx) => {
    const rank = rankBySeat[seatIdx];
    let pt = (seat.points - CONFIG.oka.kaeshi) / 1000; // 素点（×1000点）
    if (rank === 1) pt += okaPer1000; // オカ総取り
    pt += CONFIG.uma[rank - 1]; // ウマ
    const baseYen = pt * yenPer1000;
    const tipYen = tipNetByRank[rank - 1];
    return {
      seatIdx,
      rank,
      yen: Math.round(baseYen + tipYen),
      tipYen,
    };
  });

  return { seats };
}

/** 客の資金に収支を反映。0以下で飛び（busted=true を返す）。 */
export function applyBankroll(customer: Customer, deltaYen: number): { busted: boolean } {
  customer.bankroll += deltaYen;
  if (customer.bankroll <= 0) {
    customer.bankroll = 0;
    return { busted: true };
  }
  return { busted: false };
}

// ---- 内部ヘルパー ----

/** 簡易ポアソン乱数（Knuth 法）。 */
function poissonish(lambda: number, rng: Rng): number {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.next();
  } while (p > L);
  return k - 1;
}

/** レートの表示色クラス用。 */
export function rateLabel(rate: Rate): string {
  return rate === "BLUE" ? "ブルー卓(点5)" : "グリーン卓(点3)";
}
