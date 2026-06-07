// 簡易スモークテスト: 実際のエンジンを多数tick回し、破綻しないか確認する。
// 実行: npx tsx scripts/smoketest.ts
import { CONFIG } from "../src/game/config";
import { settleHanchan } from "../src/game/economy";
import { createInitialState } from "../src/game/state";
import { tick } from "../src/game/engine";
import {
  combineAction,
  honsoAction,
  openTableAction,
  seatCustomerAction,
} from "../src/game/actions";
import { firstEmptyIdx } from "../src/game/tables";
import type { GameState, Rate } from "../src/game/types";

// ---- 1) 精算がゼロサムか（場代・祝儀を除いた素点ベース）----
{
  const state = createInitialState(42);
  // ダミー卓を作って精算を100回検証
  let maxAbsSum = 0;
  for (let i = 0; i < 200; i++) {
    const seats = [0, 1, 2, 3].map(() => ({
      occupant: { kind: "STAFF" as const, staffId: 0 },
      points: 25000,
      isDealer: false,
    }));
    const table = {
      id: 1,
      rate: "GREEN" as Rate, // GREENは祝儀なし → 完全ゼロサムのはず
      seats: seats as never,
      progress: { status: "SETTLING" as const, elapsedMin: 0, hanchanCount: 0 },
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
let busts = 0;
let rage = 0;
let hanchan = 0;
for (const seed of [1, 7, 42, 100, 2024]) {
  const s = autoPlay(seed);
  totalRev += s.revenue.total;
  busts += s.stats.busts;
  rage += s.stats.rageQuits;
  hanchan += s.stats.hanchanPlayed;
  console.log(
    `[day seed=${seed}] 売上=¥${s.revenue.total.toLocaleString()} 半荘=${s.stats.hanchanPlayed} 接客=${s.stats.served} 怒=${s.stats.rageQuits} 飛=${s.stats.busts} 評判=${Math.round(s.reputation)} phase=${s.phase}`,
  );
  if (s.phase !== "CLOSED") throw new Error("day did not close");
}
console.log(`\n[summary] 5日平均売上=¥${Math.round(totalRev / 5).toLocaleString()} 総半荘=${hanchan} 総飛=${busts} 総怒=${rage}`);
if (totalRev <= 0) throw new Error("no revenue generated");
if (hanchan <= 0) throw new Error("no hanchan played");
console.log("\n✅ smoke test passed");
