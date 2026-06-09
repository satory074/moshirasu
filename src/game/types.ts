// ===== モシラス — 型定義（単一真実源・ロジック無し） =====
// 循環 import を避けるため、エンティティの形だけをここに集約する。

import type { Rng } from "./rng";

/** 卓のレート。BLUE=点5(ブルー卓) / GREEN=点3(グリーン卓)。 */
export type Rate = "BLUE" | "GREEN";

/** 客の希望卓。BLUE=点5のみ / GREEN=点3のみ / ANY=どちらでも良い。 */
export type Pref = "BLUE" | "GREEN" | "ANY";

/** 半荘開始前のコール。LASTHAN=ラスハン(必ず最後) / MOSHIRASU=モシラス(かもしれない)。 */
export type Call = "LASTHAN" | "MOSHIRASU";

/** 客の状態。 */
export type CustomerStatus = "WAITING" | "SEATED" | "LEFT";

/** 営業フェーズ。 */
export type Phase = "OPEN" | "CLOSING" | "CLOSED";

/** 半荘の進行状態。 */
export type HanchanStatus =
  | "WAITING_TO_START" // 席が埋まるのを待っている
  | "EAST" // 東場（この間のみ交代可能）
  | "SOUTH" // 南場
  | "SETTLING" // 精算（1tick）
  | "DONE";

/** 客。 */
export interface Customer {
  id: number;
  name: string;
  emoji: string;
  pref: Pref;
  /** 強さ 0..1（着順を上に歪める）。 */
  skill: number;
  /** ツキ 0..1（半荘ごとに微ドリフト）。 */
  luck: number;
  /** 所持資金（円）。0以下で飛び→離席。 */
  bankroll: number;
  startBankroll: number;
  /** 我慢の限界（分）。これを超えて待つと怒って帰る。 */
  patienceMin: number;
  /** 待ち列で経過した時間（分）。 */
  waitedMin: number;
  /** 帰宅時刻（その日の絶対分。例: 22:30 = 1350）。 */
  leaveByMin: number;
  /** 着席中の座席参照。 */
  seatRef?: { tableId: number; seatIdx: number };
  status: CustomerStatus;
  /** 統計用: 来店時刻（分）。 */
  arrivedAtMin: number;
  /** この客が払った場代の累計（円）。 */
  feePaid: number;
  /** これまで打ち終えた半荘数（最低3半荘の判定に使用）。 */
  hanchansPlayed: number;
  /** 交代で悪い位置をどこまで許容するかの性格 0..1（高いほど受諾寄り）。 */
  swapTol: number;
  /** 交代を一度断った卓ID。同一卓へは再オファーしない。 */
  refusedTables: number[];
}

/** 本走に入れる店員。 */
export interface Staff {
  id: number;
  name: string;
  /** 本走で着席中は true。 */
  busy: boolean;
}

/** 座席の占有者。 */
export type Occupant =
  | { kind: "CUSTOMER"; customerId: number }
  | { kind: "STAFF"; staffId: number } // 本走 → 場代なし
  | { kind: "EMPTY" };

/** 座席。 */
export interface Seat {
  occupant: Occupant;
  /** 半荘開始時に設定される客のコール。 */
  call?: Call;
  /** 現在の点棒（交代受諾判定に使用）。 */
  points: number;
  /** 親かどうか。 */
  isDealer: boolean;
}

/** 半荘進行。 */
export interface HanchanProgress {
  /** 現在の場（EAST=東場 / SOUTH=南場）と前後状態。 */
  status: HanchanStatus;
  /** 現在の半荘で経過した分。 */
  elapsedMin: number;
  /** この卓で完了した半荘数。 */
  hanchanCount: number;
  /** 現在の局番号（その場での 1..4。東1局なら 1）。 */
  kyoku: number;
  /** 本場（連荘・流局の積み）。 */
  honba: number;
  /** 現在の親席 index（0..3）。 */
  dealerSeat: number;
  /** この半荘で解決済みの局数（局境界での点棒移動回数）。 */
  resolvedKyoku: number;
}

/** 卓。 */
export interface Table {
  id: number;
  rate: Rate;
  seats: [Seat, Seat, Seat, Seat];
  progress: HanchanProgress;
  openedAtMin: number;
}

/** イベントログの種別（色分け用）。 */
export type LogKind =
  | "ARRIVAL"
  | "SEAT"
  | "HONSO"
  | "SWAP"
  | "COMBINE"
  | "SETTLE"
  | "LEAVE"
  | "RAGE"
  | "BUST"
  | "OPEN"
  | "INFO";

/** イベントログ1件。 */
export interface LogEntry {
  id: number;
  atMin: number;
  kind: LogKind;
  text: string;
}

/** 売上内訳。 */
export interface Revenue {
  /** 場代（プレイヤーの実売上）。 */
  gameFee: number;
  /** 祝儀から店に入る分（任意・本実装では0だが拡張余地）。 */
  tips: number;
  total: number;
}

/** 経費内訳（利益＝売上−経費）。 */
export interface Expenses {
  /** 店員の人件費（時給×人数×営業時間の累計）。 */
  wages: number;
}

/** 集計統計。 */
export interface Stats {
  /** 着席までこぎつけた客数（延べ）。 */
  served: number;
  /** プレイされた半荘の総数。 */
  hanchanPlayed: number;
  /** うち点5(BLUE)卓の半荘数（点5中心プレイの判定＝称号用）。 */
  blueHanchanPlayed: number;
  /** 怒って帰った客数。 */
  rageQuits: number;
  /** 資金が尽きて飛んだ客数。 */
  busts: number;
  /** 同時待ち人数のピーク。 */
  peakWaiting: number;
  /** 満足して帰った客数（帰宅時刻 or ラスハン/モシラスで普通に離席）。 */
  satisfied: number;
  /** 待ち時間の合計（平均算出用）。 */
  totalWaitMin: number;
  /** 待ち時間を計上した客数。 */
  waitSamples: number;
}

/** ゲーム全体の状態（権威ある単一オブジェクト）。 */
export interface GameState {
  seed: number;
  rng: Rng;
  /** その日の経過分（開店=720 など）。 */
  clockMin: number;
  phase: Phase;
  /** ターン制: 「次のイベントへ」自動進行アニメ中なら true（UIボタン抑止用）。 */
  advancing: boolean;
  tables: Table[];
  /** 待ち客（到着順）。 */
  waiting: Customer[];
  /** 離席済みも含む全客の記録（統計用、参照解決用）。 */
  customers: Map<number, Customer>;
  staff: Staff[];
  revenue: Revenue;
  /** 経費（人件費など）。利益＝revenue.total−expenses.wages。 */
  expenses: Expenses;
  /** 評判 0..100。来店率に影響。 */
  reputation: number;
  stats: Stats;
  /** イベントログ（新しい順、上限あり）。 */
  eventLog: LogEntry[];
  nextId: number;
}

/** プレイヤーアクションの結果。 */
export type Result =
  | { ok: true }
  | { ok: false; reason: string };
