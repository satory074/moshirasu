// 簡易スモークテスト: 実際のエンジンを多数tick回し、破綻しないか確認する。
// 実行: npx tsx scripts/smoketest.ts
import { CONFIG, scoreRank } from "../src/game/config";
import { settleHanchan } from "../src/game/economy";
import { createInitialState } from "../src/game/state";
import { tick, snapshot, detectStop } from "../src/game/engine";
import {
  changeRateAction,
  combineAction,
  honsoAction,
  openTableAction,
  seatCustomerAction,
} from "../src/game/actions";
import { spawnCustomer } from "../src/game/customers";
import { LocalRankingStore, type ScoreEntry } from "../src/game/ranking";
import {
  applyDayResult,
  defaultProfile,
  loadProfile,
  saveProfile,
  type DayResult,
  type KV,
} from "../src/game/profile";
import { firstEmptyIdx, freeStaff } from "../src/game/tables";
import type { GameState, Rate } from "../src/game/types";

// ---- 1) 精算がゼロサムか（実点棒ベース・場代/祝儀を除いた素点ベース）----
{
  const state = createInitialState(42);
  // ダミー卓を作って精算を200回検証。実点棒は局シミュ同様「合計100000」になるよう生成。
  let maxAbsSum = 0;
  for (let i = 0; i < 200; i++) {
    // ランダムに点棒を振り分け、合計を 100000 にゼロサム化（マイナスも許容）。
    const raw = [0, 1, 2, 3].map(() => state.rng.range(-20000, 60000));
    const adj = (raw.reduce((a, b) => a + b, 0) - 100000) / 4;
    const pts = raw.map((p) => Math.round(p - adj));
    pts[3] += 100000 - pts.reduce((a, b) => a + b, 0); // 端数を1席で吸収→合計ちょうど100000
    const seats = [0, 1, 2, 3].map((idx) => ({
      occupant: { kind: "STAFF" as const, staffId: 0 },
      points: pts[idx],
      isDealer: idx === 0,
    }));
    const table = {
      id: 1,
      rate: "GREEN" as Rate, // GREENは祝儀なし → 完全ゼロサムのはず
      seats: seats as never,
      progress: {
        status: "SETTLING" as const,
        elapsedMin: 0,
        hanchanCount: 0,
        kyoku: 4,
        honba: 0,
        dealerSeat: 0,
        resolvedKyoku: 8,
      },
      openedAtMin: 720,
    };
    const res = settleHanchan(table, state.customers, state.rng);
    const sum = res.seats.reduce((a, s) => a + s.yen, 0);
    maxAbsSum = Math.max(maxAbsSum, Math.abs(sum));
    // 着順が1..4の一意集合か
    const ranks = res.seats.map((s) => s.rank).sort().join(",");
    if (ranks !== "1,2,3,4") throw new Error(`ranks not unique: ${ranks}`);
  }
  console.log(`[settle] GREEN zero-sum max |Σyen| over 200 = ${maxAbsSum} (期待: 0付近, 丸め誤差±4)`);
  if (maxAbsSum > 5) throw new Error("settlement not zero-sum");
}

// ---- 1b) 役（和了点）分布が実データに整合（依頼: 実分布を点棒に反映）----
// handValues は子のロン基準点。engine が親×1.5・ツモ分割を別途適用するので realized≈子基準×~1.14。
// 実データ（天鳳・鳳凰卓赤あり）: 平均和了点~5,647・満貫以上~15-20%。
{
  const hv = CONFIG.kyoku.handValues;
  const totW = hv.reduce((a, [, w]) => a + w, 0);
  const avg = hv.reduce((a, [v, w]) => a + v * w, 0) / totW;
  const manganPlus = hv.filter(([v]) => v >= 8000).reduce((a, [, w]) => a + w, 0) / totW;
  const realized = avg * 1.14;
  console.log(
    `[hand-dist] 子基準平均=${Math.round(avg)}点 realized≈${Math.round(realized)}点 満貫+=${(manganPlus * 100).toFixed(1)}%（実データ: 平均~5,647・満貫+~15-20%）`,
  );
  if (avg < 4500 || avg > 5300)
    throw new Error(`和了点の子基準平均が範囲外: ${Math.round(avg)}（目標~4,900＝realized~5,600）`);
  if (manganPlus < 0.14 || manganPlus > 0.23)
    throw new Error(`満貫以上の割合が範囲外: ${(manganPlus * 100).toFixed(1)}%（実データ~15-20%）`);
}

// ---- 2) フルデイ実行: 例外なく閉店まで、売上が出るか ----
function autoPlay(seed: number): GameState {
  const state = createInitialState(seed);
  let guard = 0;
  while (state.phase !== "CLOSED" && guard < 100000) {
    guard++;
    // 簡易AI: 待ち4人以上で卓を立てる/案内/本走
    autoManage(state);
    tick(state);
  }
  return state;
}

function autoManage(state: GameState) {
  // 既存卓の空席を本走/案内で埋める
  for (const t of state.tables) {
    if (t.progress.status !== "WAITING_TO_START") continue;
    while (firstEmptyIdx(t) >= 0) {
      const idx = firstEmptyIdx(t);
      // 同レート希望 or ANY の待ち客を案内
      const cand = state.waiting.find((c) => c.pref === "ANY" || c.pref === t.rate);
      if (cand) {
        const r = seatCustomerAction(state, cand.id, t.id, idx);
        if (!r.ok) break;
      } else {
        // 客がいなければ本走（客が1人以上いる卓のみ）
        const st = freeStaff(state);
        if (!st) break;
        const r = honsoAction(state, t.id, idx, st.id);
        if (!r.ok) break;
      }
    }
  }
  // 新規卓: 待ち客がいて卓数に余裕
  if (state.tables.length < CONFIG.maxTables && state.waiting.length >= 1) {
    // ブルー希望/グリーン希望/ANY を集める
    const blue = state.waiting.filter((c) => c.pref === "BLUE" || c.pref === "ANY").slice(0, 4);
    const green = state.waiting.filter((c) => c.pref === "GREEN").slice(0, 4);
    if (blue.length >= 2) {
      openTableAction(state, "BLUE", blue.map((c) => c.id));
    } else if (green.length >= 2) {
      openTableAction(state, "GREEN", green.map((c) => c.id));
    }
  }
  // 合卓の機会があれば試す（半荘前の同レート2卓）
  const idle = state.tables.filter((t) => t.progress.status === "WAITING_TO_START");
  if (idle.length >= 2) combineAction(state, idle[0].id, idle[1].id);
}

// ---- 2b) 攻めの点5一辺倒: 飛びが発生しうるか ----
function autoPlayBlue(seed: number): GameState {
  const state = createInitialState(seed);
  let guard = 0;
  while (state.phase !== "CLOSED" && guard < 100000) {
    guard++;
    for (const t of state.tables) {
      if (t.progress.status !== "WAITING_TO_START") continue;
      while (firstEmptyIdx(t) >= 0) {
        const idx = firstEmptyIdx(t);
        const cand = state.waiting.find((c) => c.pref === "ANY" || c.pref === t.rate);
        if (cand) {
          if (!seatCustomerAction(state, cand.id, t.id, idx).ok) break;
        } else {
          const st = freeStaff(state);
          if (!st || !honsoAction(state, t.id, idx, st.id).ok) break;
        }
      }
    }
    if (state.tables.length < CONFIG.maxTables) {
      const blue = state.waiting.filter((c) => c.pref === "BLUE" || c.pref === "ANY").slice(0, 4);
      if (blue.length >= 1) openTableAction(state, "BLUE", blue.map((c) => c.id));
    }
    tick(state);
  }
  return state;
}
{
  // (a) 点5は円の振れが大きい（リアルな差はレート¥/1000点＋祝儀のみ。点棒移動はレート非依存）。
  //     同じゼロサム点棒を点5/点3で精算し、平均|円収支|を比較する。
  const vs = createInitialState(7);
  function meanAbsYen(rate: Rate): number {
    let total = 0;
    let n = 0;
    for (let i = 0; i < 400; i++) {
      const raw = [0, 1, 2, 3].map(() => vs.rng.range(-20000, 60000));
      const adj = (raw.reduce((a, b) => a + b, 0) - 100000) / 4;
      const pts = raw.map((p) => Math.round(p - adj));
      pts[3] += 100000 - pts.reduce((a, b) => a + b, 0);
      const seats = [0, 1, 2, 3].map((idx) => ({
        occupant: { kind: "STAFF" as const, staffId: 0 },
        points: pts[idx],
        isDealer: idx === 0,
      }));
      const table = {
        id: 1,
        rate,
        seats: seats as never,
        progress: { status: "SETTLING" as const, elapsedMin: 0, hanchanCount: 0, kyoku: 4, honba: 0, dealerSeat: 0, resolvedKyoku: 8 },
        openedAtMin: 720,
      };
      const res = settleHanchan(table, vs.customers, vs.rng);
      for (const s of res.seats) {
        total += Math.abs(s.yen);
        n++;
      }
    }
    return total / n;
  }
  const blueAbs = meanAbsYen("BLUE");
  const greenAbs = meanAbsYen("GREEN");
  // (b) 点5一辺倒の飛び数は観測のみ（blueHandMult撤去でレート由来＝稀。ハードな下限は設けない）。
  let busts = 0;
  let rev = 0;
  for (const seed of [1, 7, 42, 100, 2024]) {
    const s = autoPlayBlue(seed);
    busts += s.stats.busts;
    rev += s.revenue.total;
  }
  console.log(
    `[blue-volatility] 平均|円収支| 点5=¥${Math.round(blueAbs)} 点3=¥${Math.round(greenAbs)}（比 ${(blueAbs / greenAbs).toFixed(2)}x）｜点5一辺倒5日 総飛=${busts} 平均売上=¥${Math.round(rev / 5).toLocaleString()}`,
  );
  // 点5の振れが点3を明確に上回ること（リアルな高レートの体験＝円の振れ）。
  if (!(blueAbs > greenAbs * 2))
    throw new Error(`点5の円の振れが点3の2倍未満（${(blueAbs / greenAbs).toFixed(2)}x）: rateYenPer1000.BLUE/祝儀を見直す`);
}

let totalRev = 0;
let totalProfit = 0;
let busts = 0;
let rage = 0;
let hanchan = 0;
for (const seed of [1, 7, 42, 100, 2024]) {
  const s = autoPlay(seed);
  const profit = s.revenue.total - s.expenses.wages;
  totalRev += s.revenue.total;
  totalProfit += profit;
  busts += s.stats.busts;
  rage += s.stats.rageQuits;
  hanchan += s.stats.hanchanPlayed;
  console.log(
    `[day seed=${seed}] 売上=¥${s.revenue.total.toLocaleString()} 人件費=¥${Math.round(s.expenses.wages).toLocaleString()} 利益=¥${Math.round(profit).toLocaleString()} 半荘=${s.stats.hanchanPlayed} 接客=${s.stats.served} 怒=${s.stats.rageQuits} 飛=${s.stats.busts} 評判=${Math.round(s.reputation)} phase=${s.phase}`,
  );
  if (s.phase !== "CLOSED") throw new Error("day did not close");
  // 人件費が発生していること（営業時間×店員数）。
  if (s.expenses.wages <= 0) throw new Error("no wages accrued");
}
const avgProfit = totalProfit / 5;
console.log(
  `\n[summary] 5日平均 売上=¥${Math.round(totalRev / 5).toLocaleString()} 利益=¥${Math.round(avgProfit).toLocaleString()} 総半荘=${hanchan} 総飛=${busts} 総怒=${rage}`,
);
if (totalRev <= 0) throw new Error("no revenue generated");
if (hanchan <= 0) throw new Error("no hanchan played");

// ---- 2d) 点5の旨味: 同条件で点5中心 > 点3一辺倒（リスクに見合うリターン）----
// autoManage は点5中心（BLUE/ANY→BLUE）。比較用に点3一辺倒AIで同seedを回し、
// 点5中心プレイの平均利益が点3一辺倒を明確に上回ること＝「高レートは怖いがリターンも大きい」を回帰保証。
function autoPlayGreen(seed: number): GameState {
  const state = createInitialState(seed);
  let guard = 0;
  while (state.phase !== "CLOSED" && guard < 100000) {
    guard++;
    for (const t of state.tables) {
      if (t.progress.status !== "WAITING_TO_START") continue;
      while (firstEmptyIdx(t) >= 0) {
        const idx = firstEmptyIdx(t);
        const cand = state.waiting.find((c) => c.pref === "ANY" || c.pref === t.rate);
        if (cand) {
          if (!seatCustomerAction(state, cand.id, t.id, idx).ok) break;
        } else {
          const st = freeStaff(state);
          if (!st || !honsoAction(state, t.id, idx, st.id).ok) break;
        }
      }
    }
    if (state.tables.length < CONFIG.maxTables) {
      const green = state.waiting.filter((c) => c.pref === "GREEN" || c.pref === "ANY").slice(0, 4);
      if (green.length >= 2) openTableAction(state, "GREEN", green.map((c) => c.id));
    }
    tick(state);
  }
  return state;
}
{
  const seeds = [1, 7, 42, 100, 2024];
  let blueProfit = 0;
  let greenProfit = 0;
  for (const seed of seeds) {
    blueProfit += autoPlay(seed).revenue.total - autoPlay(seed).expenses.wages; // 点5中心
    const g = autoPlayGreen(seed);
    greenProfit += g.revenue.total - g.expenses.wages;
  }
  const blueAvg = blueProfit / seeds.length;
  const greenAvg = greenProfit / seeds.length;
  console.log(`[blue-vs-green] 点5中心 平均利益=¥${Math.round(blueAvg).toLocaleString()} > 点3一辺倒 平均利益=¥${Math.round(greenAvg).toLocaleString()}`);
  if (!(blueAvg > greenAvg * 1.3))
    throw new Error(`点5中心(${Math.round(blueAvg)})が点3一辺倒(${Math.round(greenAvg)})を1.3倍超で上回らない: 点5のリターンが不足（gameFeeYen.BLUE を見直す）`);
}

// ---- 2e) スコア帯: 最適寄りプレイの平均利益が B 帯(¥34k〜)に入る（運だけでDに落ちない校正）----
{
  const { rank } = scoreRank(avgProfit);
  console.log(`[score-band] 最適寄り5日平均 利益=¥${Math.round(avgProfit).toLocaleString()} → ランク${rank}（B帯=¥34k〜が及第点）`);
  if (avgProfit < 34000)
    throw new Error(`最適寄り平均利益がB帯(¥34k)未満: targetProfit/scoreRank の校正がズレている`);
}

// ---- 2c) セッション長: 1プレイの「決定停止回数」が ~5分相当の帯に収まるか ----
// ターン制なので実時間 ≈ Σ(人間の判断時間)。停止(detectStop)回数がそのまま手数＝体感時間。
// 最適寄りAIで平均~72回(seed毎 57〜88)。速い判断なら~4分、じっくりでも~6分に収まる想定。
// 営業時間/来店レートを変えるとここがズレるので、~5分の目安帯(45〜100回)を回帰ガードする。
{
  let totalStops = 0;
  const seeds = [1, 2, 3, 12345, 777, 999, 42, 2024, 55, 8];
  for (const seed of seeds) {
    const state = createInitialState(seed);
    let stops = 0;
    let guard = 0;
    while (state.phase !== "CLOSED" && guard < 100000) {
      guard++;
      autoManage(state); // プレイヤーの手（最適寄り）を毎tick反映
      const prev = snapshot(state);
      tick(state);
      if (detectStop(prev, state)) stops++;
    }
    totalStops += stops;
  }
  const avgStops = totalStops / seeds.length;
  console.log(`[session] 10seed平均 決定停止回数=${avgStops.toFixed(1)}（~5分の目安帯: 45〜100）`);
  if (avgStops < 45 || avgStops > 100)
    throw new Error(`セッション長が目安帯を外れた: 平均停止${avgStops.toFixed(1)}（営業時間/来店レートを見直す）`);
}

// ---- 3) 開店前設定の店員数が反映され、人件費が店員数にスケールする ----
{
  // createInitialState 第2引数で店員数を指定できる。
  if (createInitialState(7, 5).staff.length !== 5) throw new Error("staffCount not applied");
  if (createInitialState(7, 1).staff.length !== 1) throw new Error("staffCount=1 not applied");

  // 同条件で営業させると、店員が多いほど人件費が大きい。
  const few = createInitialState(7, 1);
  const many = createInitialState(7, 8);
  for (let i = 0; i < 120; i++) {
    tick(few);
    tick(many);
  }
  if (!(many.expenses.wages > few.expenses.wages)) {
    throw new Error(`wages should scale with staff: few=${few.expenses.wages} many=${many.expenses.wages}`);
  }
  console.log(
    `[staff] 店員数=設定可（1/5/8）。120分で人件費 1人=¥${Math.round(few.expenses.wages)} < 8人=¥${Math.round(many.expenses.wages)}`,
  );
}

// ---- 3b) ローカルランキング: 利益降順＋タイブレークで並ぶ ----
{
  const store = new LocalRankingStore(); // node は localStorage 無 → メモリ実装
  const mk = (id: string, profit: number, served: number, atIso: string): ScoreEntry => ({
    id,
    name: id,
    profit,
    rank: "B",
    staffCount: 2,
    served,
    hanchan: 10,
    seed: 1,
    atIso,
  });
  await store.submit(mk("a", 100000, 5, "2026-01-01T00:00:00.000Z"));
  await store.submit(mk("b", 300000, 5, "2026-01-01T00:00:00.000Z"));
  await store.submit(mk("c", 200000, 5, "2026-01-01T00:00:00.000Z"));
  // タイブレーク: 同利益は接客数が多い方が上。
  await store.submit(mk("d", 300000, 9, "2026-01-01T00:00:01.000Z"));
  const top = await store.fetchTop(10);
  const order = top.map((e) => e.id).join(",");
  if (order !== "d,b,c,a") throw new Error(`ranking order wrong: ${order}`);
  console.log(`[ranking] 利益降順＋タイブレーク OK: ${order}`);
}

// ---- 4) 局シミュ: 半荘中の点棒合計は常に 100000（ゼロサム移動）----
{
  const state = createInitialState(123);
  let checks = 0;
  let guard = 0;
  while (state.phase !== "CLOSED" && guard < 100000) {
    guard++;
    autoManage(state);
    tick(state);
    for (const t of state.tables) {
      if (t.progress.status === "EAST" || t.progress.status === "SOUTH") {
        const sum = t.seats.reduce((a, s) => a + s.points, 0);
        if (sum !== 100000) throw new Error(`点棒合計が100000でない: ${sum}（卓#${t.id}）`);
        checks++;
      }
    }
  }
  console.log(`[kyoku] 対局中の点棒合計=100000 を ${checks} 回確認`);
  if (checks === 0) throw new Error("no in-play point-sum checks ran");
}

// ---- 5) 卓数上限（5分プレイ向けに 8 卓へ縮小）----
if (CONFIG.maxTables !== 8) throw new Error(`maxTables expected 8, got ${CONFIG.maxTables}`);
console.log(`[tables] maxTables=${CONFIG.maxTables}`);

// ---- 6) レート違いの合卓: 希望が両立すれば集約できる ----
{
  const state = createInitialState(99);
  const c1 = spawnCustomer(state);
  c1.pref = "ANY"; // どちらでも
  const c2 = spawnCustomer(state);
  c2.pref = "BLUE"; // 点5希望
  if (!openTableAction(state, "GREEN", [c1.id]).ok) throw new Error("open green failed");
  if (!openTableAction(state, "BLUE", [c2.id]).ok) throw new Error("open blue failed");
  const [ta, tb] = state.tables;
  const cr = combineAction(state, ta.id, tb.id);
  if (!cr.ok) throw new Error(`cross-rate combine failed: ${(cr as { reason: string }).reason}`);
  if (state.tables.length !== 1) throw new Error("combine should leave 1 table");
  const merged = state.tables[0];
  if (merged.rate !== "BLUE") throw new Error(`merged rate should be BLUE, got ${merged.rate}`);
  const custs = merged.seats.filter((s) => s.occupant.kind === "CUSTOMER").length;
  if (custs !== 2) throw new Error(`merged should have 2 customers, got ${custs}`);
  console.log(`[combine] 点3(どちらでも)＋点5希望 → 点5卓に合卓 OK（客${custs}人）`);

  // 希望が衝突する場合は不可（点5希望 vs 点3希望）
  const s2 = createInitialState(98);
  const g = spawnCustomer(s2);
  g.pref = "GREEN";
  const b = spawnCustomer(s2);
  b.pref = "BLUE";
  openTableAction(s2, "GREEN", [g.id]);
  openTableAction(s2, "BLUE", [b.id]);
  const bad = combineAction(s2, s2.tables[0].id, s2.tables[1].id);
  if (bad.ok) throw new Error("conflicting-pref combine should fail");
  console.log("[combine] 点3希望＋点5希望 → 正しく合卓拒否");
}

// ---- 7) レート変更: 客が全員「どちらでも」なら切替可、混在は不可 ----
{
  const state = createInitialState(55);
  const c = spawnCustomer(state);
  c.pref = "ANY";
  openTableAction(state, "GREEN", [c.id]);
  const t = state.tables[0];
  const before = t.rate;
  if (!changeRateAction(state, t.id).ok) throw new Error("changeRate failed");
  if (t.rate === before) throw new Error("rate did not change");
  console.log(`[rate] 全員どちらでも → レート ${before}→${t.rate} に変更 OK`);
  const c2 = spawnCustomer(state);
  c2.pref = "BLUE"; // 卓は now BLUE なので着席可
  seatCustomerAction(state, c2.id, t.id, firstEmptyIdx(t));
  if (changeRateAction(state, t.id).ok) throw new Error("changeRate should fail with non-ANY customer");
  console.log("[rate] 点5希望が混在 → レート変更を正しく拒否");
}

// ---- 8) プロフィール: 通算加算・称号解放・自己ベスト・storage往復・旧キー移行 ----
{
  const mkKV = (seed?: Record<string, string>): KV => {
    const mem = new Map<string, string>(Object.entries(seed ?? {}));
    return { get: (k) => (mem.has(k) ? mem.get(k)! : null), set: (k, v) => void mem.set(k, v) };
  };
  const day = (over: Partial<DayResult> = {}): DayResult => ({
    profit: 40000, rank: "B", served: 30, hanchan: 30, blueHanchan: 20, busts: 0, satisfied: 25, rageQuits: 3, reputation: 90, ...over,
  });

  // 加算 + 初営業/無事故 称号 + 自己ベスト
  let p = defaultProfile();
  let r = applyDayResult(p, day({ profit: 40000, busts: 0 }));
  if (r.profile.gamesPlayed !== 1) throw new Error("gamesPlayed not incremented");
  if (r.profile.bestProfit !== 40000) throw new Error("bestProfit not set");
  if (!r.isNewBest) throw new Error("first day should be new best");
  if (r.profile.cleanDays !== 1) throw new Error("cleanDays not counted");
  const ids1 = r.newAchievements.map((a) => a.id);
  if (!ids1.includes("first-day") || !ids1.includes("clean-day")) throw new Error(`first-day/clean-day not unlocked: ${ids1}`);

  // 2日目: 低い利益はベスト更新しない・既存称号は再解放しない
  r = applyDayResult(r.profile, day({ profit: 10000, busts: 2 }));
  if (r.isNewBest) throw new Error("lower profit should not be new best");
  if (r.profile.bestProfit !== 40000) throw new Error("bestProfit regressed");
  if (r.newAchievements.some((a) => a.id === "first-day")) throw new Error("first-day re-unlocked");

  // 点5の鬼: 点5比率7割以上＆A評価以上
  r = applyDayResult(r.profile, day({ profit: 55000, rank: "A", hanchan: 30, blueHanchan: 24 }));
  if (!r.newAchievements.some((a) => a.id === "blue-master")) throw new Error("blue-master not unlocked");
  // S評価
  r = applyDayResult(r.profile, day({ profit: 70000, rank: "S" }));
  if (!r.newAchievements.some((a) => a.id === "rank-s")) throw new Error("rank-s not unlocked");
  console.log(`[profile] 通算加算・称号解放OK（解放数=${r.profile.unlockedAchievements.length} 通算${r.profile.gamesPlayed}日 ベスト¥${r.profile.bestProfit?.toLocaleString()}）`);

  // storage 往復
  const kv = mkKV();
  saveProfile(r.profile, kv);
  const reloaded = loadProfile(kv);
  if (reloaded.gamesPlayed !== r.profile.gamesPlayed || reloaded.bestProfit !== r.profile.bestProfit)
    throw new Error("profile round-trip mismatch");
  if (reloaded.unlockedAchievements.length !== r.profile.unlockedAchievements.length)
    throw new Error("achievements round-trip mismatch");

  // 旧キー移行（プロフィール未保存・旧 name/best のみ）
  const legacy = loadProfile(mkKV({ "moshirasu.playerName": "旧店長", "moshirasu.bestProfit": "33000" }));
  if (legacy.playerName !== "旧店長" || legacy.bestProfit !== 33000)
    throw new Error(`legacy migration failed: ${legacy.playerName}/${legacy.bestProfit}`);
  console.log("[profile] storage往復・旧キー移行 OK");
}

console.log("\n✅ smoke test passed");
