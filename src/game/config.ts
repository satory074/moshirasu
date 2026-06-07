// ===== バランス調整は全てこのファイルで完結する =====
// 他モジュールにはバランスに効く数値リテラルを置かない。

import type { Rate } from "./types";

export const CONFIG = {
  // ---- 時計（その日の分。12:00=720, 24:00=1440）----
  openMin: 720, // 12:00 開店
  closeMin: 1410, // 23:30 ラストオーダー（以降は新規来店なし・進行中は完走）
  hardCloseMin: 1500, // 25:00 強制閉店（残っていても締める）
  minutesPerTick: 1, // 1tickでゲーム内1分進む
  advanceTickMs: 55, // ターン制: 「次のイベントへ」自動進行アニメの1tick間隔（見やすい速さ）
  maxStepsPerFrame: 8, // 1フレームあたりの最大tick数（停止条件まで滑らかに進める）
  urgentRatio: 0.75, // 待ち客の「緊急」しきい値（我慢ゲージ比。停止条件＆赤表示に共用）

  // ---- 半荘の長さ（分）----
  eastMin: 7, // 東場（この間のみ交代可能）
  southMin: 7, // 南場
  // 合計14分/半荘 → 1日で1卓あたり最大 ~50半荘

  // ---- 卓数 ----
  maxTables: 4,

  // ---- 来店 ----
  // 時間帯別の相対重み（昼ピーク・夜ピーク）。キーは「時」。
  arrivalCurveByHour: {
    12: 0.7,
    13: 0.8,
    14: 0.5,
    15: 0.4,
    16: 0.4,
    17: 0.6,
    18: 0.9,
    19: 1.0,
    20: 1.0,
    21: 0.95,
    22: 0.7,
    23: 0.4,
  } as Record<number, number>,
  baseArrivalChancePerTick: 0.13, // 1tickあたりの来店確率の基準値
  reputationArrivalFactor: 0.6, // 評判が低いと来店を抑制する強さ（0で無影響）
  maxWaitingSpawn: 12, // 待ち列がこれ以上なら来店抑制（席が無いのに溢れさせない）

  // ---- 希望分布 ----
  prefWeights: { BLUE: 0.25, GREEN: 0.35, ANY: 0.4 } as Record<string, number>,

  // ---- 経済 ----
  // 場代（客1人・1半荘あたり）= プレイヤーの実売上。点5の方を高く設定。
  gameFeeYen: { BLUE: 600, GREEN: 350 } as Record<Rate, number>,
  // レート（1000点あたりの円）。点5=¥50, 点3=¥30。
  rateYenPer1000: { BLUE: 50, GREEN: 30 } as Record<Rate, number>,
  oka: { mochi: 25000, kaeshi: 30000 }, // 25000持ち30000返し → 1位に+20000
  uma: [20, 10, -10, -20] as number[], // ウマ（×1000点）
  // 点棒スプレッドのテンプレ範囲（×1000点）。ゼロサムに正規化される。
  // 振れ幅を大きめにして、負けが込むと資金が尽きる体験を効かせる。
  pointSpread: { xMin: 20, xMax: 48, yMin: 4, yMax: 16 },
  bigSwingChance: 0.14, // 大物手直撃・箱割れの発生率
  bigSwingMult: 1.9, // そのときのトップ/ラスの点差倍率
  // 祝儀（点5のみ）。着順で枚数の期待値が変わる。資金変動を増幅。
  tipYen: 1000,
  tipMeanByRank: [1.2, 0.6, 0.3, 0.1] as number[],

  // ---- 客のステータス分布 ----
  skill: { mean: 0.5, sd: 0.18 },
  luck: { mean: 0.5, sd: 0.15, driftSd: 0.05 },
  bankrollYen: { mean: 45000, sd: 18000, min: 12000 },
  patienceMin: { mean: 28, sd: 9, min: 8 },
  sessionLenMin: { mean: 170, sd: 55, min: 60 }, // leaveByMin = arrival + これ

  // ---- 着順シミュ（economy）----
  settle: { wSkill: 1.0, wLuck: 0.7, sigma: 0.5 },

  // ---- コール / 交代 ----
  moshirasuLeaveProb: 0.4, // モシラスの客が実際に抜ける基準確率
  // ラスハンに寄せるバイアス（帰宅間近・資金薄）。
  callLasthanBias: { nearLeaveByMin: 30, nearLeaveByBoost: 0.45, lowBankrollRatio: 0.3, lowBankrollBoost: 0.35 },
  baseLasthanProb: 0.18, // 平常時にラスハンする確率
  // 交代受諾。点棒リード・親で受諾↑、帰宅間近で受諾↓。
  swap: { base: 0.5, kPoints: 0.000012, dealerBonus: 0.15, kLateMin: 0.006 },

  // ---- 評判 ----
  reputation: {
    start: 70,
    max: 100,
    min: 0,
    rageHit: 4, // 怒り離席で減
    bustHit: 1.5, // 飛びで減
    serveGain: 0.6, // 着席させると増
    satisfiedGain: 1.0, // 満足して帰すと増
  },

  // ---- その他 ----
  staffCount: 2, // 本走に入れる店員の人数
  logCap: 120,
  targetRevenue: 120000, // スコア評価の基準（S/A/B/C 判定）

  // 客が来店時に既存卓へ案内されるのを待つ猶予など、将来の拡張用フック。
} as const;

/** 評価レター。 */
export function scoreRank(revenue: number): { rank: string; comment: string } {
  const t = CONFIG.targetRevenue;
  if (revenue >= t * 1.5) return { rank: "S", comment: "伝説の雀荘マネージャー！" };
  if (revenue >= t * 1.2) return { rank: "A", comment: "見事な卓回し。常連も大満足。" };
  if (revenue >= t * 0.9) return { rank: "B", comment: "堅実な営業。及第点。" };
  if (revenue >= t * 0.6) return { rank: "C", comment: "もう少し回転を上げたい。" };
  return { rank: "D", comment: "卓が立たず閑古鳥…修行あるのみ。" };
}
