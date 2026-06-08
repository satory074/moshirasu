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
    progress: {
      status: "WAITING_TO_START",
      elapsedMin: 0,
      hanchanCount: 0,
      kyoku: 1,
      honba: 0,
      dealerSeat: 0,
      resolvedKyoku: 0,
    },
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
      // 最低3半荘打つつもり: 次半荘が物理的に入るのに3半荘未満なら、
      // ラスハンコールを大きく抑える（=モシラス濃厚）。時間切れ濃厚(0.95)はそのまま。
      if (
        c.hanchansPlayed < CONFIG.minHanchanIntent &&
        minsLeft > CONFIG.eastMin + CONFIG.southMin
      )
        pLasthan *= CONFIG.under3LasthanMult;
      seat.call = state.rng.chance(pLasthan) ? "LASTHAN" : "MOSHIRASU";
    }
  };
}

/**
 * 卓の半荘進行を dtMin ぶん進める。
 * WAITING_TO_START → (満席なら) 東1局 …（局ごとに点棒移動・親番ローテ）… オーラス → 精算 → 次半荘へ
 * 飛び（誰かの点棒 < 0）は即精算。連荘で半荘長は可変（CONFIG.kyoku.maxKyokuPerHanchan で上限）。
 */
export function advanceHanchan(state: GameState, table: Table, dtMin: number): void {
  const p = table.progress;
  switch (p.status) {
    case "WAITING_TO_START": {
      if (isFull(table)) {
        startHanchan(state, table);
      }
      break;
    }
    case "EAST":
    case "SOUTH": {
      p.elapsedMin += dtMin;
      advanceKyokus(state, table);
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
        p.resolvedKyoku = 0;
        p.kyoku = 1;
        p.honba = 0;
        p.dealerSeat = 0;
        p.hanchanCount++;
      }
      break;
    }
    case "DONE":
      break;
  }
}

/** 満席の卓で半荘を開始する（東1局へ）。 */
function startHanchan(state: GameState, table: Table): void {
  const p = table.progress;
  rollCalls(state)(table);
  p.status = "EAST";
  p.elapsedMin = 0;
  p.kyoku = 1;
  p.honba = 0;
  p.dealerSeat = 0;
  p.resolvedKyoku = 0;
  for (const seat of table.seats) {
    seat.points = CONFIG.oka.mochi; // 25000持ち
    // 半荘が実際に始まったので、着席客の「開始待ち」をリセット。
    if (seat.occupant.kind === "CUSTOMER") {
      const c = state.customers.get(seat.occupant.customerId);
      if (c) c.waitedMin = 0;
    }
  }
  setDealerFlags(table, 0);
  addLog(
    state,
    "OPEN",
    `🀄 卓#${tableNo(state, table)}（${table.rate === "BLUE" ? "点5" : "点3"}）東1局開始`,
  );
}

/**
 * 経過分が局境界を越えるたびに1局ぶん解決し、局/場/親を進める。
 * 飛び or オーラス完了 or 局数上限で精算（SETTLING）へ。
 */
function advanceKyokus(state: GameState, table: Table): void {
  const p = table.progress;
  const k = CONFIG.kyoku;
  while (
    p.resolvedKyoku < k.maxKyokuPerHanchan &&
    p.elapsedMin >= (p.resolvedKyoku + 1) * k.kyokuMin
  ) {
    const res = resolveKyoku(state, table);
    p.resolvedKyoku++;
    if (res.busted) {
      p.status = "SETTLING";
      return;
    }
    const isAllLast = p.status === "SOUTH" && p.kyoku >= 4;
    if (res.renchan && p.honba < k.maxHonba) {
      // 連荘（親の和了/聴牌）。オーラスで親がトップなら上がり止め。
      if (isAllLast && isDealerLeading(table, p.dealerSeat)) {
        p.status = "SETTLING";
        return;
      }
      p.honba++;
    } else {
      // 親流れ。オーラスを親が流れたら半荘終了。
      if (isAllLast) {
        p.status = "SETTLING";
        return;
      }
      p.honba = 0;
      p.dealerSeat = (p.dealerSeat + 1) % 4;
      p.kyoku++;
      if (p.status === "EAST" && p.kyoku > 4) {
        p.status = "SOUTH";
        p.kyoku = 1;
      }
      setDealerFlags(table, p.dealerSeat);
    }
  }
  // 局数上限に達したら（連荘が長引いた等）打ち切って精算。
  if (p.resolvedKyoku >= k.maxKyokuPerHanchan && p.status !== "SETTLING") {
    p.status = "SETTLING";
  }
}

/**
 * 1局を解決して点棒を移動する（4席ゼロサム・本走も打つ）。
 * 流局 or 和了者抽選（強さ・ツキ＋親補正）→ ツモ/ロンで実点棒を移動。
 * 戻り値: 連荘するか（親の和了/親聴牌流局）と、飛び（点棒<0）が出たか。
 */
function resolveKyoku(state: GameState, table: Table): { renchan: boolean; busted: boolean } {
  const rng = state.rng;
  const k = CONFIG.kyoku;
  const dealer = table.progress.dealerSeat;

  // --- 流局 ---
  if (rng.chance(k.ryuukyokuProb)) {
    const tenpai = table.seats.map((s) => rng.chance(0.4 + 0.35 * statsOf(state, s).skill));
    const nT = tenpai.filter(Boolean).length;
    if (nT > 0 && nT < 4) {
      // ノーテン罰符をテンパイ者で山分け（整数・ゼロサム）。
      let pool = 0;
      const loss = Math.round(k.notenPenalty / (4 - nT));
      table.seats.forEach((s, i) => {
        if (!tenpai[i]) {
          s.points -= loss;
          pool += loss;
        }
      });
      const each = Math.floor(pool / nT);
      let rem = pool - each * nT;
      table.seats.forEach((s, i) => {
        if (tenpai[i]) {
          let g = each;
          if (rem > 0) {
            g++;
            rem--;
          }
          s.points += g;
        }
      });
    }
    return { renchan: !!tenpai[dealer], busted: hasMinus(table) };
  }

  // --- 和了者抽選（強さ・ツキのソフトマックス＋親補正）---
  const weights = table.seats.map((s, i) => {
    const { skill, luck } = statsOf(state, s);
    let w = Math.exp(k.winSkillW * skill + k.winLuckW * luck);
    if (i === dealer) w *= k.dealerWinMult;
    return w;
  });
  const winner = weightedIndex(rng, weights);
  const winnerIsDealer = winner === dealer;

  // 手の点数（子のロン基準点）。ヘビーテール。点5卓は手が大きく振れる（飛びのリスク）。
  let handPts = Math.round(rng.weighted<number>(k.handValues));
  if (table.rate === "BLUE") handPts = Math.round(handPts * k.blueHandMult);
  const tsumo = rng.chance(k.tsumoProb);
  const honba = table.progress.honba;
  // 実麻雀の支払いに寄せ、各支払いを100点単位に丸める（勝者は丸め後の合計をそのまま得るので
  // ゼロサムは厳守。Σ点棒≡100000）。
  const r100 = (x: number) => Math.round(x / 100) * 100;

  let collected = 0;
  if (tsumo) {
    // ツモ: 全員から徴収。本場は1人につき+100×本場。
    table.seats.forEach((s, i) => {
      if (i === winner) return;
      let pay: number;
      if (winnerIsDealer) {
        // 親ツモ: 3人が均等に handPts×1.5/3（=子基準の半額オール）。
        pay = r100((handPts * 1.5) / 3);
      } else {
        // 子ツモ: 親=handPts/2, 子=handPts/4（子-子-親 = x-x-2x）。
        pay = i === dealer ? r100(handPts / 2) : r100(handPts / 4);
      }
      pay += 100 * honba;
      s.points -= pay;
      collected += pay;
    });
  } else {
    // ロン: 放銃者抽選（敗者の中から、低skillほど振り込みやすい）。本場は+300×本場。
    const losers = [0, 1, 2, 3].filter((i) => i !== winner);
    const lw = losers.map((i) => Math.exp(-k.winSkillW * statsOf(state, table.seats[i]).skill));
    const discarder = losers[weightedIndex(rng, lw)];
    // 親のロンは1.5倍（親満貫12000など）。
    const pay = (winnerIsDealer ? r100(handPts * 1.5) : r100(handPts)) + 300 * honba;
    table.seats[discarder].points -= pay;
    collected = pay;
  }
  table.seats[winner].points += collected;

  return { renchan: winnerIsDealer, busted: hasMinus(table) };
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
    // この半荘を打ち終えた。最低3半荘の判定はこのカウントに基づく。
    c.hanchansPlayed++;

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
 * 交代可能か: 「まもなく開始(開始待ち)」または東場の間 かつ 本走席がある。
 */
export function canSwapHonso(table: Table): boolean {
  const st = table.progress.status;
  return (st === "WAITING_TO_START" || st === "EAST") && hasHonso(table);
}

/**
 * 客が本走席と交代を試みる。受諾は客ごとの条件で多要素判定:
 * - 自分（=継ぐ席）の点棒状況
 * - トップとの差
 * - 親が残っているか（継ぐ席が現在の親か／半荘の残り＝親番がまだ回るか）
 * - 拒否した場合の待ち時間（待つほど妥協して受諾↑）
 * - 客ごとの許容度 swapTol
 * 成功なら客を着席・店員を解放。拒否時はその卓を refusedTables に記録（再オファー禁止）。
 * seatIdx を渡すとその本走席を対象に、未指定なら最初の本走席を対象にする。
 */
export function attemptSwap(
  state: GameState,
  table: Table,
  customer: Customer,
  seatIdx?: number,
): { ok: boolean; accepted: boolean } {
  if (!canSwapHonso(table)) return { ok: false, accepted: false };
  const idx =
    seatIdx !== undefined && table.seats[seatIdx]?.occupant.kind === "STAFF"
      ? seatIdx
      : table.seats.findIndex((s) => s.occupant.kind === "STAFF");
  if (idx < 0) return { ok: false, accepted: false };
  const seat = table.seats[idx];

  // 受諾確率（多要素）
  const sw = CONFIG.swap;
  const topPoints = Math.max(...table.seats.map((s) => s.points));
  const gap = Math.max(0, topPoints - seat.points); // トップとの差
  const remain =
    1 - Math.min(1, table.progress.resolvedKyoku / CONFIG.kyoku.maxKyokuPerHanchan); // 親番の残り
  const waitRatio = Math.max(0, Math.min(1, customer.waitedMin / customer.patienceMin));

  let p: number = sw.base;
  p += (seat.points - CONFIG.oka.mochi) * sw.kPoints; // 自分の点棒状況
  p -= gap * sw.kTopGap; // トップとの差
  if (seat.isDealer) p += sw.dealerBonus; // 親残存（現在親席）
  p += remain * sw.kRemain; // 親番がまだ回る
  p += waitRatio * sw.kWait; // 拒否した場合の待ち時間
  p += (customer.swapTol - 0.5) * sw.kTol; // 客ごとの条件
  p = Math.max(sw.pMin, Math.min(sw.pMax, p));

  if (!state.rng.chance(p)) {
    // 一度断った卓には再度交代を出せない（同一卓への再オファー禁止）。
    if (!customer.refusedTables.includes(table.id)) {
      customer.refusedTables.push(table.id);
    }
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
 * 2卓を合卓できるか（構造条件のみ）。
 * - 両方とも WAITING_TO_START（半荘前）
 * - 客の合計が 1〜4 人
 * レートは異なっていてもよい。実際にどのレートへ集約するか（客の希望が
 * 両立するか）は `actions.combineAction` が判定する。
 */
export function canCombine(a: Table, b: Table): boolean {
  if (a.id === b.id) return false;
  if (a.progress.status !== "WAITING_TO_START") return false;
  if (b.progress.status !== "WAITING_TO_START") return false;
  const totalCustomers = customerCount(a) + customerCount(b);
  return totalCustomers >= 1 && totalCustomers <= 4;
}

/**
 * 卓のレートを変更できるか。
 * - 半荘前（WAITING_TO_START）
 * - 客が1人以上いて、全員が「どちらでも(ANY)」希望
 * （点5/点3 を明確に希望する客が1人でもいれば不可）
 */
export function canChangeRate(state: GameState, table: Table): boolean {
  if (table.progress.status !== "WAITING_TO_START") return false;
  let customers = 0;
  for (const seat of table.seats) {
    if (seat.occupant.kind !== "CUSTOMER") continue;
    customers++;
    const c = state.customers.get(seat.occupant.customerId);
    if (!c || c.pref !== "ANY") return false;
  }
  return customers >= 1;
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

/**
 * 開始待ち（WAITING_TO_START・満席前）の卓に着席している客の待ち時間を進める。
 * 我慢の限界を超えたら席を立って帰る（怒り離席）。満席卓はこのtickで開始されるため対象外。
 */
export function tickSeatedWaiting(state: GameState, dtMin: number): void {
  for (const table of [...state.tables]) {
    if (table.progress.status !== "WAITING_TO_START") continue;
    if (isFull(table)) continue; // まもなく開始 → 開始処理に任せる
    for (let i = 0; i < 4; i++) {
      const seat = table.seats[i];
      if (seat.occupant.kind !== "CUSTOMER") continue;
      const c = state.customers.get(seat.occupant.customerId);
      if (!c) continue;
      c.waitedMin += dtMin * CONFIG.kyoku.seatedWaitMult;
      if (c.waitedMin >= c.patienceMin) {
        // 開始を待ちきれず席を立つ（怒り離席）。
        removeFromSeat(state, table, i);
        c.status = "LEFT";
        state.stats.rageQuits++;
        state.stats.totalWaitMin += c.waitedMin;
        state.stats.waitSamples++;
        adjustReputation(state, -CONFIG.reputation.rageHit);
        addLog(
          state,
          "RAGE",
          `💢 ${c.name} が開始を待ちきれず席を立った（待ち${Math.round(c.waitedMin)}分）`,
        );
      }
    }
  }
}

// ---- 内部（局シミュ）----

/** 座席の打ち手の能力。客は本人の skill/luck、本走の店員は平均的な打ち手。 */
function statsOf(state: GameState, seat: Seat): { skill: number; luck: number } {
  if (seat.occupant.kind === "CUSTOMER") {
    const c = state.customers.get(seat.occupant.customerId);
    if (c) return { skill: c.skill, luck: c.luck };
  }
  return { skill: 0.55, luck: 0.5 };
}

/** 重み配列から1つ抽選し、その index を返す。 */
function weightedIndex(rng: GameState["rng"], weights: number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

/** 各席の親フラグを更新する。 */
function setDealerFlags(table: Table, dealerSeat: number): void {
  for (let i = 0; i < 4; i++) table.seats[i].isDealer = i === dealerSeat;
}

/** 親が現在トップ（最大点棒）か。オーラスの上がり止め判定に使う。 */
function isDealerLeading(table: Table, dealerSeat: number): boolean {
  const dp = table.seats[dealerSeat].points;
  return table.seats.every((s, i) => i === dealerSeat || dp >= s.points);
}

/** どれかの席が点棒マイナス（飛び）か。 */
function hasMinus(table: Table): boolean {
  return table.seats.some((s) => s.points < 0);
}

function clampLuck(x: number): number {
  return Math.max(0.05, Math.min(0.95, x));
}
