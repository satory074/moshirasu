// ===== 経済・精算数式（純関数）=====
// プレイヤーの売上 = 場代（客席のみ）。
// 客の資金 = 半荘ごとの着順精算（オカ/ウマ/祝儀）で増減。

import { CONFIG } from "./config";
import type { Rng } from "./rng";
import type { Customer, Rate, Seat, Table } from "./types";

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
 * 半荘を精算する。
 * 1. 各席の強さ・ツキ＋乱数で評価値を出し、降順ソートで着順1..4を決定
 * 2. 着順テンプレで点棒スプレッド生成 → ゼロサムに正規化
 * 3. 30000返し・オカ+20000(1位)・ウマを適用（ゼロサム維持）
 * 4. レートで円換算、点5は祝儀を加算
 *
 * customers: 座席占有者の客を引くためのマップ。
 */
export function settleHanchan(
  table: Table,
  customers: Map<number, Customer>,
  rng: Rng,
): SettlementResult {
  // --- 各席の評価値（着順の素）---
  const scored = table.seats.map((seat, seatIdx) => {
    const { skill, luck } = seatStats(seat, customers);
    const r =
      skill * CONFIG.settle.wSkill +
      luck * CONFIG.settle.wLuck +
      rng.gaussian(0, CONFIG.settle.sigma);
    return { seatIdx, r };
  });
  // 降順 → 着順
  scored.sort((a, b) => b.r - a.r);
  const rankBySeat = new Array<number>(4);
  scored.forEach((s, i) => {
    rankBySeat[s.seatIdx] = i + 1; // 1..4
  });

  // --- 点棒スプレッド（×1000点、着順順に [+X,+Y,-Y,-X]）---
  const sp = CONFIG.pointSpread;
  let X = rng.range(sp.xMin, sp.xMax);
  const Y = rng.range(sp.yMin, sp.yMax);
  // 大物手の直撃・箱割れ大差（テールリスク）。たまに大きく振れ、
  // 薄い資金の客が1半荘で飛ぶことがある＝高レートの怖さ。
  if (rng.chance(CONFIG.bigSwingChance)) {
    X *= CONFIG.bigSwingMult;
  }
  // 着順別の生の点（合計0）。
  const rawByRank = [X, Y, -Y, -X]; // index 0 = 1位

  // --- オカ・ウマ適用（×1000点単位で計算）---
  // 30000返しは「持ち点-返し点」を全員から引く＝ゼロサムには影響しないが
  // オカ(+20000を1位)で1位だけ底上げ。ウマは [+20,+10,-10,-20]。
  // ここでは生スプレッドが既に「素点差」を表すので、オカ・ウマを上乗せする。
  const okaPer1000 = (CONFIG.oka.kaeshi - CONFIG.oka.mochi) / 1000; // 5 (×1000=5000) ×4人=20000
  const finalByRank = rawByRank.map((raw, rank) => {
    let pt = raw;
    if (rank === 0) pt += okaPer1000 * 4; // オカ +20000(×1000=20) を1位総取り
    pt += CONFIG.uma[rank]; // ウマ
    return pt; // ×1000点単位
  });
  // オカ分だけ合計がプラスにずれるので、全員から均等に戻してゼロサム化。
  const sum = finalByRank.reduce((a, b) => a + b, 0);
  const adj = sum / 4;
  const zeroSumByRank = finalByRank.map((pt) => pt - adj);

  // --- 祝儀（点5のみ・ゼロサム）---
  // 現実同様、下位が上位に祝儀を支払う。点5の振れ幅を増やし、
  // 薄い資金の客は1〜2半荘の大敗で飛びうる（高レートのリスク）。
  const tipNetByRank = [0, 0, 0, 0]; // 着順index → 円（+受取/−支払）
  if (table.rate === "BLUE") {
    // この半荘で動く祝儀の枚数（一発・裏・赤など）。
    const volume = poissonish(CONFIG.tipMeanByRank[0] + 0.5, rng);
    const totalTipYen = volume * CONFIG.tipYen;
    // 配分: 1位総取り気味、2位やや受け、3・4位が支払い（合計0）。
    const share = [0.6, 0.15, -0.25, -0.5];
    for (let r = 0; r < 4; r++) tipNetByRank[r] = Math.round(totalTipYen * share[r]);
    // 端数のゼロサム補正
    const drift = tipNetByRank.reduce((a, b) => a + b, 0);
    tipNetByRank[0] -= drift;
  }

  // --- 円換算 ---
  const yenPer1000 = CONFIG.rateYenPer1000[table.rate];
  const seats: SeatSettlement[] = table.seats.map((_seat, seatIdx) => {
    const rank = rankBySeat[seatIdx];
    const baseYen = zeroSumByRank[rank - 1] * yenPer1000;
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

function seatStats(
  seat: Seat,
  customers: Map<number, Customer>,
): { skill: number; luck: number } {
  if (seat.occupant.kind === "CUSTOMER") {
    const c = customers.get(seat.occupant.customerId);
    if (c) return { skill: c.skill, luck: c.luck };
  }
  // 本走の店員は平均的な打ち手として扱う。
  return { skill: 0.55, luck: 0.5 };
}

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
