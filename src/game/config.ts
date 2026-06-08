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
  // 局シミュ化に伴い、半荘長は「局数×kyokuMin」で可変（連荘で伸びる）。
  // eastMin/southMin は进行バーや一部表示の目安として残す。
  eastMin: 7, // 東場（目安）
  southMin: 7, // 南場（目安）

  // ---- 局シミュレーション（本格進行: 親番ローテ・局ごとの実点移動）----
  kyoku: {
    kyokuMin: 1.4, // 1局あたりの目安進行分
    maxKyokuPerHanchan: 14, // 半荘の局数上限（連荘暴走ガード）
    maxHonba: 4, // 本場の上限（超えたら親流れ）
    ryuukyokuProb: 0.16, // 流局率
    notenPenalty: 3000, // 流局のノーテン罰符（総額・テンパイ者で山分け）
    tsumoProb: 0.42, // ツモ率（残りはロン）
    winSkillW: 2.2, // 和了者抽選: 強さの効き
    winLuckW: 1.4, // 和了者抽選: ツキの効き
    dealerWinMult: 1.25, // 親は和了しやすい
    // 手の点数分布（点, 重み）。ヘビーテール。大物手の直撃で点棒が大きく振れ、
    // 点5では薄い資金の客が飛びうる（高レートのリスク＝このゲームの肝）。
    handValues: [
      [1500, 26],
      [2900, 23],
      [3900, 18],
      [5200, 12],
      [7700, 9],
      [8000, 7],
      [12000, 4.5],
      [16000, 2.2],
      [24000, 1],
      [32000, 0.5],
    ] as [number, number][],
    // 着席後（半荘前）の待ちは、列で待つより気が長い。我慢ゲージの進みを緩める。
    seatedWaitMult: 0.5,
    // 点5(BLUE)は赤・祝儀の世界で手が大きく振れる。点5卓の手の点数を増幅し、
    // 薄い資金の客が飛ぶ「高レートの怖さ」を演出する（点3=GREENは等倍）。
    blueHandMult: 1.5,
  },

  // ---- 卓数 ----
  maxTables: 12,

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
  maxWaitingSpawn: 16, // 待ち列がこれ以上なら来店抑制（卓数12に合わせ少し広げる）

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
  // 客は最低3半荘打つつもりで来店する（ソフト保証）。3半荘未満では
  // 自主離席・ラスハンコールの確率を大きく抑える（稀に早く帰るのは許容）。
  // 飛び・帰宅時刻（時間切れ）による離席は別経路で従来通り強制される。
  minHanchanIntent: 3, // 客が打つつもりの最低半荘数
  under3LeaveMult: 0.15, // 3半荘未満のモシラス自主離席 確率倍率
  under3LasthanMult: 0.15, // 3半荘未満のラスハンコール 確率倍率
  // 交代受諾。点棒リード・親で受諾↑、帰宅間近で受諾↓。
  swap: { base: 0.5, kPoints: 0.000012, dealerBonus: 0.15, kLateMin: 0.006 },

  // ---- 評判 ----
  reputation: {
    start: 70,
    max: 100,
    min: 0,
    rageHit: 3, // 怒り離席で減
    bustHit: 1.5, // 飛びで減
    serveGain: 0.6, // 着席させると増
    satisfiedGain: 1.0, // 満足して帰すと増
  },

  // ---- 店員・人件費・利益 ----
  // 店員数は「開店前の設定画面」で一度だけ決める（進行中の増員は不可）。
  staffCount: 2, // 開店前設定の初期値（デフォルト店員数）
  staffMin: 1, // 設定で選べる最小店員数（最大は maxTables*4 を使用箇所で導出＝全席を本走で埋められる上限）
  wagePerHourYen: 1200, // 店員1人あたりの時給（人件費）。多いほど利益を圧迫。
  targetProfit: 90000, // スコア評価の基準（利益＝売上−人件費）

  // ---- その他 ----
  logCap: 120,
  targetRevenue: 120000, // 旧基準（参考値）

  // 客が来店時に既存卓へ案内されるのを待つ猶予など、将来の拡張用フック。
} as const;

/** 評価レター（利益＝売上−人件費 で判定）。 */
export function scoreRank(profit: number): { rank: string; comment: string } {
  const t = CONFIG.targetProfit;
  if (profit >= t * 1.5) return { rank: "S", comment: "伝説の雀荘マネージャー！" };
  if (profit >= t * 1.2) return { rank: "A", comment: "見事な卓回し。常連も大満足。" };
  if (profit >= t * 0.9) return { rank: "B", comment: "堅実な営業。及第点。" };
  if (profit >= t * 0.6) return { rank: "C", comment: "もう少し回転を上げたい。" };
  return { rank: "D", comment: "人件費に見合う回転を作ろう…修行あるのみ。" };
}
