// DOM レベルのスモークテスト: render.ts が例外なく描画し、
// クリック→アクション→着席が DOM に反映されるかを jsdom で検証する。
// 実行: npx tsx scripts/domtest.ts
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!DOCTYPE html><body><main id="app"></main></body>`, {
  pretendToBeVisual: true,
});
// グローバルに DOM を注入（render.ts は document / window を使う）
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.requestAnimationFrame = () => 0;
g.cancelAnimationFrame = () => {};

// 動的 import（グローバル注入後に読む必要がある）
const { createRenderer } = await import("../src/game/render");
const { createInitialState } = await import("../src/game/state");
const { tick } = await import("../src/game/engine");
const {
  openTableAction,
  seatCustomerAction,
  honsoAction,
} = await import("../src/game/actions");
import type { Command } from "../src/game/render";
import type { GameState, Result } from "../src/game/types";

const root = dom.window.document.getElementById("app")!;
const state: GameState = createInitialState(42);

function toRes(r: Result) {
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}
const dispatch = (cmd: Command) => {
  switch (cmd.type) {
    case "openTable":
      return toRes(openTableAction(state, cmd.rate, cmd.customerIds));
    case "seat":
      return toRes(seatCustomerAction(state, cmd.customerId, cmd.tableId));
    case "honso":
      return toRes(honsoAction(state, cmd.tableId));
    default:
      return { ok: true };
  }
};

const renderer = createRenderer(root as unknown as HTMLElement, dispatch);
renderer.reset();
renderer.render(state);

// SHELL が構築されたか
assert(!!root.querySelector("#clock"), "HUD clock exists");
assert(!!root.querySelector("#tables"), "tables region exists");

// 数十分進めて客を集める
for (let i = 0; i < 60; i++) {
  tick(state);
  renderer.render(state);
}
const waitChips = root.querySelectorAll(".wchip");
console.log(`[dom] 60tick後の待ち客チップ数 = ${waitChips.length}, 待ち客 state=${state.waiting.length}`);
assert(waitChips.length === state.waiting.length, "待ち客チップ数が state と一致");

// 卓を立てる（待ち客が2人以上いれば）
if (state.waiting.length >= 1) {
  const ids = state.waiting.slice(0, 3).map((c) => c.id);
  const before = state.waiting.length;
  // pref を満たすレートを選ぶ（最初の客の希望）
  const first = state.waiting[0];
  const rate = first.pref === "GREEN" ? "GREEN" : "BLUE";
  const eligible = state.waiting
    .filter((c) => c.pref === "ANY" || c.pref === rate)
    .slice(0, 3)
    .map((c) => c.id);
  const r = openTableAction(state, rate, eligible);
  renderer.render(state);
  console.log(`[dom] 卓立て ${rate}: ${r.ok ? "成功" : "失敗:" + (r as { reason: string }).reason}`);
  assert(r.ok, "卓を立てられた");
  assert(state.tables.length === 1, "卓が1つできた");
  assert(state.waiting.length < before, "待ち客が減った");
  void ids;
  // DOM に卓カードが現れたか
  assert(root.querySelectorAll(".table-card").length === 1, "卓カードが描画された");
  // 空席があれば本走で埋める
  const t = state.tables[0];
  if (t.seats.some((s) => s.occupant.kind === "EMPTY")) {
    const hr = honsoAction(state, t.id);
    renderer.render(state);
    console.log(`[dom] 本走: ${hr.ok ? "成功" : "失敗:" + (hr as { reason: string }).reason}`);
  }
}

// 閉店まで一気に進めて結果画面が出るか
let guard = 0;
while (state.phase !== "CLOSED" && guard < 100000) {
  guard++;
  // 空席を本走で埋め続ける（卓が止まらないように）
  for (const t of state.tables) {
    if (t.progress.status === "WAITING_TO_START") {
      const cand = state.waiting.find((c) => c.pref === "ANY" || c.pref === t.rate);
      if (cand) seatCustomerAction(state, cand.id, t.id);
      else if (t.seats.some((s) => s.occupant.kind === "EMPTY")) honsoAction(state, t.id);
    }
  }
  tick(state);
}
renderer.render(state);
const overlay = root.querySelector("#result")!;
console.log(`[dom] 閉店: phase=${state.phase}, 結果画面表示=${overlay.className.includes("show")}, 売上=¥${state.revenue.total.toLocaleString()}`);
assert(state.phase === "CLOSED", "閉店した");
assert(overlay.className.includes("show"), "結果画面が表示された");
assert(!!root.querySelector(".result-rank"), "ランク表示がある");

console.log("\n✅ DOM smoke test passed");

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
}
