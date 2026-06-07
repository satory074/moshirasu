// ===== 客のライフサイクル（誰が存在し、まだ居るか）=====

import { CONFIG } from "./config";
import { genNameEmoji } from "./names";
import { addLog, adjustReputation, nextId } from "./state";
import type { Customer, GameState, Pref, Seat } from "./types";

/** 来店抽選。1tickごとに呼ぶ。来店したら待ち列に追加。 */
export function maybeSpawnArrival(state: GameState): void {
  if (state.phase !== "OPEN") return;
  if (state.waiting.length >= CONFIG.maxWaitingSpawn) return;

  const hour = Math.floor(state.clockMin / 60);
  const curve = CONFIG.arrivalCurveByHour[hour] ?? 0.3;
  // 評判で変調（評判50を基準に ±）。
  const repFactor =
    1 + ((state.reputation - 50) / 50) * CONFIG.reputationArrivalFactor;
  const p = CONFIG.baseArrivalChancePerTick * curve * Math.max(0.1, repFactor);

  if (state.rng.chance(p)) {
    spawnCustomer(state);
  }
}

/** 1人の客を生成して待ち列へ。 */
export function spawnCustomer(state: GameState): Customer {
  const rng = state.rng;
  const { name, emoji } = genNameEmoji(rng);
  const pref = rng.weighted<Pref>([
    ["BLUE", CONFIG.prefWeights.BLUE],
    ["GREEN", CONFIG.prefWeights.GREEN],
    ["ANY", CONFIG.prefWeights.ANY],
  ]);
  const skill = clamp01(rng.gaussian(CONFIG.skill.mean, CONFIG.skill.sd));
  const luck = clamp01(rng.gaussian(CONFIG.luck.mean, CONFIG.luck.sd));
  const bankroll = Math.max(
    CONFIG.bankrollYen.min,
    Math.round(rng.gaussian(CONFIG.bankrollYen.mean, CONFIG.bankrollYen.sd)),
  );
  const patienceMin = Math.max(
    CONFIG.patienceMin.min,
    Math.round(rng.gaussian(CONFIG.patienceMin.mean, CONFIG.patienceMin.sd)),
  );
  const sessionLen = Math.max(
    CONFIG.sessionLenMin.min,
    Math.round(rng.gaussian(CONFIG.sessionLenMin.mean, CONFIG.sessionLenMin.sd)),
  );

  const customer: Customer = {
    id: nextId(state),
    name,
    emoji,
    pref,
    skill,
    luck,
    bankroll,
    startBankroll: bankroll,
    patienceMin,
    waitedMin: 0,
    leaveByMin: state.clockMin + sessionLen,
    status: "WAITING",
    arrivedAtMin: state.clockMin,
    feePaid: 0,
  };
  state.customers.set(customer.id, customer);
  state.waiting.push(customer);

  const prefLabel =
    pref === "BLUE" ? "点5希望" : pref === "GREEN" ? "点3希望" : "どちらでも";
  addLog(state, "ARRIVAL", `${customer.emoji} ${customer.name} が来店（${prefLabel}）`);

  if (state.waiting.length > state.stats.peakWaiting) {
    state.stats.peakWaiting = state.waiting.length;
  }
  return customer;
}

/**
 * 待ち客の時間を進める。
 * - 我慢の限界を超えたら怒って帰る
 * - 帰宅時刻に到達したら（着席できず）帰る
 * 帰った客は待ち列から除去し、ログ・評判を更新。
 */
export function tickWaiting(state: GameState, dtMin: number): void {
  const remaining: Customer[] = [];
  for (const c of state.waiting) {
    c.waitedMin += dtMin;
    if (c.waitedMin >= c.patienceMin) {
      // 怒り離席
      c.status = "LEFT";
      state.stats.rageQuits++;
      recordWait(state, c);
      adjustReputation(state, -CONFIG.reputation.rageHit);
      addLog(
        state,
        "RAGE",
        `💢 ${c.name} が待ちきれず帰った（待ち${Math.round(c.waitedMin)}分）`,
      );
      continue;
    }
    if (state.clockMin >= c.leaveByMin) {
      // 時間切れ（着席できなかった）
      c.status = "LEFT";
      recordWait(state, c);
      addLog(state, "LEAVE", `🚪 ${c.name} は時間が来たので帰った（着席できず）`);
      continue;
    }
    remaining.push(c);
  }
  state.waiting = remaining;
}

/**
 * 半荘終了後、着席客が抜けるかどうかを判定する。
 * - ラスハン: 必ず抜ける
 * - 資金0: 必ず抜ける（飛び）
 * - 帰宅時刻到達: 必ず抜ける
 * - モシラス: 確率で抜ける（帰宅間近・資金薄で上昇）
 * busted=true は資金切れ。
 */
export function decideLeaveOrStay(
  state: GameState,
  customer: Customer,
  seat: Seat,
  busted: boolean,
): { leaves: boolean; reason: "BUST" | "LASTHAN" | "TIMEUP" | "MOSHIRASU" | null } {
  if (busted) return { leaves: true, reason: "BUST" };
  if (seat.call === "LASTHAN") return { leaves: true, reason: "LASTHAN" };
  if (state.clockMin >= customer.leaveByMin) return { leaves: true, reason: "TIMEUP" };

  // モシラス: 確率で抜ける
  let p = CONFIG.moshirasuLeaveProb;
  const minsLeft = customer.leaveByMin - state.clockMin;
  if (minsLeft <= CONFIG.callLasthanBias.nearLeaveByMin) p += 0.25;
  const ratio = customer.bankroll / Math.max(1, customer.startBankroll);
  if (ratio <= CONFIG.callLasthanBias.lowBankrollRatio) p += 0.2;
  if (state.rng.chance(p)) return { leaves: true, reason: "MOSHIRASU" };
  return { leaves: false, reason: null };
}

function recordWait(state: GameState, c: Customer): void {
  state.stats.totalWaitMin += c.waitedMin;
  state.stats.waitSamples++;
}

function clamp01(x: number): number {
  return Math.max(0.02, Math.min(0.98, x));
}
