// 簡易スモークテスト: 実際のエンジンを多数tick回し、破綻しないか確認する。
// 実行: npx tsx scripts/smoketest.ts
import { CONFIG } from "../src/game/config";
import { settleHanchan } from "../src/game/economy";
import { createInitialState } from "../src/game/state";
import { tick } from "../src/game/engine";
import {
  changeRateAction,
  combineAction,
  honsoAction,
  openTableAction,
  seatCustomerAction,
} from "../src/game/actions";
import { spawnCustomer } from "../src/game/customers";
import { LocalRankingStore, type ScoreEntry } from "../src/game/ranking";
import { firstEmptyIdx } from "../src/game/tables";
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
      // 同レート希望 or ANY の待ち客を案内
      const cand = state.waiting.find((c) => c.pref === "ANY" || c.pref === t.rate);
      if (cand) {
        const r = seatCustomerAction(state, cand.id, t.id);
        if (!r.ok) break;
      } else {
        // 客がいなければ本走（客が1人以上いる卓のみ）
        const r = honsoAction(state, t.id);
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
        const cand = state.waiting.find((c) => c.pref === "ANY" || c.pref === t.rate);
        if (cand) {
          if (!seatCustomerAction(state, cand.id, t.id).ok) break;
        } else if (!honsoAction(state, t.id).ok) break;
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
  let busts = 0;
  let rev = 0;
  for (const seed of [1, 7, 42, 100, 2024]) {
    const s = autoPlayBlue(seed);
    busts += s.stats.busts;
    rev += s.revenue.total;
  }
  console.log(`[blue-aggressive] 5日 総飛=${busts} 平均売上=¥${Math.round(rev / 5).toLocaleString()}（点5一辺倒）`);
  if (busts === 0) console.log("⚠️  点5一辺倒でも飛びが0。資金尽きの体験が薄いかも。");
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
console.log(
  `\n[summary] 5日平均 売上=¥${Math.round(totalRev / 5).toLocaleString()} 利益=¥${Math.round(totalProfit / 5).toLocaleString()} 総半荘=${hanchan} 総飛=${busts} 総怒=${rage}`,
);
if (totalRev <= 0) throw new Error("no revenue generated");
if (hanchan <= 0) throw new Error("no hanchan played");

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

// ---- 5) 卓数上限が12 ----
if (CONFIG.maxTables !== 12) throw new Error(`maxTables expected 12, got ${CONFIG.maxTables}`);
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
  seatCustomerAction(state, c2.id, t.id);
  if (changeRateAction(state, t.id).ok) throw new Error("changeRate should fail with non-ANY customer");
  console.log("[rate] 点5希望が混在 → レート変更を正しく拒否");
}

console.log("\n✅ smoke test passed");
