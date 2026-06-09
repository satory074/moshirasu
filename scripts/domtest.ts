// DOM レベルのスモークテスト: render.ts が例外なく描画し、
// クリック→アクション→着席が DOM に反映されるかを jsdom で検証する。
// 実行: npx tsx scripts/domtest.ts
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!DOCTYPE html><body><main id="app"></main></body>`, {
  url: "https://example.com/", // localStorage は opaque origin だと使えないため URL を与える
  pretendToBeVisual: true,
});
// グローバルに DOM を注入（render.ts は document / window を使う）
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.localStorage = dom.window.localStorage; // ランキング/名前の永続化テスト用
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
  honsoAllAction,
  setSpeedAction,
  swapAction,
  moveCustomerAction,
} = await import("../src/game/actions");
const { firstEmptyIdx, freeStaff } = await import("../src/game/tables");
const { spawnCustomer } = await import("../src/game/customers");
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
      return toRes(seatCustomerAction(state, cmd.customerId, cmd.tableId, cmd.seatIdx));
    case "honso":
      return toRes(honsoAction(state, cmd.tableId, cmd.seatIdx, cmd.staffId));
    case "honsoAll":
      return toRes(honsoAllAction(state));
    case "setSpeed":
      return toRes(setSpeedAction(state, cmd.mult));
    case "pause":
      state.advancing = false; // 実機では engine.stop()。ここでは進行フラグだけ落とす。
      return { ok: true };
    case "swap":
      return toRes(swapAction(state, cmd.customerId, cmd.tableId, cmd.seatIdx));
    case "move":
      return toRes(moveCustomerAction(state, cmd.customerId, cmd.tableId, cmd.seatIdx));
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

// 開店前設定オーバーレイの表示/非表示
renderer.showSetup();
const setupEl = root.querySelector("#setup")!;
assert(setupEl.className.includes("show"), "設定画面が表示された");
assert(!!root.querySelector('[data-action="start-game"]'), "開店ボタンがある");
assert(!!root.querySelector('[data-action="setup-inc"]'), "店員数ステッパーがある");
renderer.hideSetup();
assert(!setupEl.className.includes("show"), "設定画面が閉じた");
console.log("[dom] 開店前設定オーバーレイ OK");

// 進行中に「雇う」ボタンが無いこと（最初だけ決定）
assert(!root.querySelector('[data-action="hire-staff"]'), "進行中の雇うボタンは廃止");

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
    const st = freeStaff(state);
    if (st) {
      const hr = honsoAction(state, t.id, firstEmptyIdx(t), st.id);
      renderer.render(state);
      console.log(`[dom] 本走: ${hr.ok ? "成功" : "失敗:" + (hr as { reason: string }).reason}`);
    }
  }
}

// ---- 進行速度セレクタ（x1/x2/x4）----
// renderAdvance は HUD内(#advance-wrap)と下部バー(#advance-bar)の両方に同じUIを出すので、
// 片方（#advance-wrap）にスコープして数える。
{
  const wrap = root.querySelector("#advance-wrap")!;
  const pills = wrap.querySelectorAll('[data-action="set-speed"]');
  assert(pills.length === 3, "速度ピルが3つ（x1/x2/x4）");
  assert(!!wrap.querySelector('[data-action="set-speed"].speed-pill-on'), "現在速度がハイライト");
  const x4 = wrap.querySelector('[data-action="set-speed"][data-mult="4"]') as unknown as HTMLElement;
  click(x4);
  assert(state.speed === 4, "x4 クリックで state.speed=4");
  assert(
    (wrap.querySelector('[data-action="set-speed"][data-mult="4"]') as Element).className.includes("speed-pill-on"),
    "x4 がハイライトに切替",
  );
  // 不正値は無視して x1 に戻る
  setSpeedAction(state, 3);
  assert(state.speed === 1, "許可外の速度は x1 にフォールバック");
  setSpeedAction(state, 1);
  console.log("[dom] 速度セレクタ x1/x2/x4 OK");
}

// ---- 一時停止ボタン（進行中のみ）----
{
  state.advancing = true;
  renderer.render(state);
  const pauseBtn = root.querySelector('[data-action="pause"]') as unknown as HTMLElement;
  assert(!!pauseBtn, "進行中は一時停止ボタンが出る");
  assert(!root.querySelector('[data-action="advance"]'), "進行中は『次のイベントへ』は出ない");
  click(pauseBtn);
  // click→dispatch の mutation を TS は追えず advancing を true リテラルに絞るので boolean に広げて比較。
  assert((state.advancing as boolean) === false, "一時停止で advancing=false");
  renderer.render(state);
  assert(!!root.querySelector('[data-action="advance"]'), "停止後は『次のイベントへ』が戻る");
  console.log("[dom] 一時停止ボタン OK");
}

// ---- すべて本走（空席一括埋め）----
{
  const t = state.tables[0];
  if (t && t.progress.status === "WAITING_TO_START") {
    const beforeEmpty = t.seats.filter((s) => s.occupant.kind === "EMPTY").length;
    const beforeFree = state.staff.filter((s) => !s.busy).length;
    if (beforeEmpty > 0 && beforeFree > 0) {
      renderer.render(state);
      const allBtn = root.querySelector('[data-action="honso-all"]') as unknown as HTMLElement;
      assert(!!allBtn, "空席＋空き店員ありで『すべて本走』ボタンが出る");
      click(allBtn);
      const afterEmpty = t.seats.filter((s) => s.occupant.kind === "EMPTY").length;
      const expected = Math.max(0, beforeEmpty - beforeFree);
      assert(afterEmpty === expected, "空席が空き店員ぶん本走で埋まった");
      console.log(`[dom] すべて本走 OK（空席 ${beforeEmpty}→${afterEmpty}）`);
    }
  }
}

// 閉店まで一気に進めて結果画面が出るか
let guard = 0;
while (state.phase !== "CLOSED" && guard < 100000) {
  guard++;
  // 空席を本走で埋め続ける（卓が止まらないように）
  for (const t of state.tables) {
    if (t.progress.status === "WAITING_TO_START" && firstEmptyIdx(t) >= 0) {
      const idx = firstEmptyIdx(t);
      const cand = state.waiting.find((c) => c.pref === "ANY" || c.pref === t.rate);
      if (cand) seatCustomerAction(state, cand.id, t.id, idx);
      else {
        const st = freeStaff(state);
        if (st) honsoAction(state, t.id, idx, st.id);
      }
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

// 通算成績パネル＋称号（WS4）。初回閉店なので「初営業」称号が新規解放される。
assert(!!root.querySelector(".career-panel"), "通算成績パネルが表示された");
assert(!!root.querySelector(".career-ach .ach-badge"), "称号バッジが並ぶ");
assert(!!root.querySelector(".ach-new"), "新規称号ハイライトが出た（初営業）");
{
  const profStored = dom.window.localStorage.getItem("moshirasu.profile.v1");
  assert(!!profStored && profStored.includes('"gamesPlayed":1'), "プロフィールに1日ぶん加算され保存された");
}
console.log("[dom] 通算成績・称号表示＋永続化 OK");

// ランキング: 名前を入れて登録 → リスト表示＆ハイライト＆localStorage 保存
await microtask(); // loadRanking（非同期）の完了を待つ
assert(!!root.querySelector("#rank-name"), "名前入力欄がある");
const nameInput = root.querySelector("#rank-name") as unknown as { value: string };
nameInput.value = "テスト店長";
const submitBtn = root.querySelector('[data-action="submit-score"]') as unknown as { click: () => void };
submitBtn.click();
await microtask(); // onSubmitScore（非同期）の完了を待つ
const rows = root.querySelectorAll(".ranking-row");
console.log(`[dom] ランキング登録後の行数=${rows.length}`);
assert(rows.length >= 1, "ランキング行が表示された");
assert(!!root.querySelector(".ranking-me"), "自分の登録がハイライト");
const stored = dom.window.localStorage.getItem("moshirasu.ranking.v1");
assert(!!stored && stored.includes("テスト店長"), "localStorage に保存された");
console.log("[dom] ランキング登録 OK");

// ---- 席クリックのアテンド/移動/交代ピッカー ----
{
  // 旧 #app（1つ目の renderer の DOM）を除去。jsdom はスコープ付き querySelector("#id") が
  // 文書内に重複IDがあると null を返すため、2つ目の renderer の前に消す（本番は単一 renderer）。
  root.remove();
  const ps: GameState = createInitialState(7, 6); // 本走用に店員多め
  const root2 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(root2);
  const dispatch2 = (cmd: Command) => {
    switch (cmd.type) {
      case "openTable":
        return toRes(openTableAction(ps, cmd.rate, cmd.customerIds));
      case "seat":
        return toRes(seatCustomerAction(ps, cmd.customerId, cmd.tableId, cmd.seatIdx));
      case "honso":
        return toRes(honsoAction(ps, cmd.tableId, cmd.seatIdx, cmd.staffId));
      case "swap":
        return toRes(swapAction(ps, cmd.customerId, cmd.tableId, cmd.seatIdx));
      case "move":
        return toRes(moveCustomerAction(ps, cmd.customerId, cmd.tableId, cmd.seatIdx));
      default:
        return { ok: true };
    }
  };
  const r2 = createRenderer(root2 as unknown as HTMLElement, dispatch2);
  r2.reset();

  const a = spawnCustomer(ps);
  a.pref = "ANY";
  const b = spawnCustomer(ps);
  b.pref = "ANY";
  openTableAction(ps, "BLUE", [a.id]); // 卓t1（a 1人・空席3）
  const t1 = ps.tables[0];
  r2.render(ps);

  // 空席クリック → ピッカーが開き、待ち客＋店員候補が出る
  const emptySeat = root2.querySelector('[data-action="pick-seat"]') as unknown as HTMLElement;
  assert(!!emptySeat, "空席に pick-seat 属性がある");
  click(emptySeat);
  assert(!!root2.querySelector("#picker .pk-panel"), "空席クリックでピッカーが開いた");
  assert(
    !!root2.querySelector('[data-action="choose"][data-kind="cust"]'),
    "ピッカーに待ち客候補がある",
  );
  assert(
    !!root2.querySelector('[data-action="choose"][data-kind="staff"]'),
    "ピッカーに空き店員候補がある",
  );

  // 待ち客 b を選んで着席
  const beforeWaiting = ps.waiting.length;
  click(root2.querySelector(`[data-action="choose"][data-kind="cust"][data-id="${b.id}"]`) as unknown as HTMLElement);
  assert(ps.waiting.length === beforeWaiting - 1, "案内で待ち客が1人減った");
  assert(b.status === "SEATED" && b.seatRef?.tableId === t1.id, "b が t1 に着席");
  assert(!root2.querySelector("#picker .pk-panel"), "選択後にピッカーが閉じた");
  console.log("[dom] 空席クリック→案内 OK");

  // pick-close でピッカーを閉じる
  click(root2.querySelector('[data-action="pick-seat"]') as unknown as HTMLElement);
  assert(!!root2.querySelector("#picker .pk-panel"), "ピッカーを再度開いた");
  click(root2.querySelector('[data-action="pick-close"]') as unknown as HTMLElement);
  assert(!root2.querySelector("#picker .pk-panel"), "pick-close でピッカーが閉じた");
  console.log("[dom] pick-close OK");

  // 別卓からの移動: 卓t2 を e 1人で立て、t1 の空席ピッカーに移動候補として出す
  const e = spawnCustomer(ps);
  e.pref = "ANY";
  openTableAction(ps, "BLUE", [e.id]);
  const tablesBefore = ps.tables.length;
  r2.render(ps);
  click(root2.querySelector(`[data-action="pick-seat"][data-id="${t1.id}"]`) as unknown as HTMLElement);
  const moveBtn = root2.querySelector(`[data-action="choose"][data-kind="move"][data-id="${e.id}"]`) as unknown as HTMLElement;
  assert(!!moveBtn, "別卓の客が移動候補として出る");
  click(moveBtn);
  assert(e.seatRef?.tableId === t1.id, "e が t1 へ移動した");
  assert(ps.tables.length === tablesBefore - 1, "空になった元卓が撤去された");
  console.log("[dom] 別卓→移動＋元卓撤去 OK");

  // 客起点の移動: 席埋め中の客本人をクリック→移動先卓ピッカーから別卓を選んで移動
  const mvSrc = spawnCustomer(ps);
  mvSrc.pref = "ANY";
  openTableAction(ps, "GREEN", [mvSrc.id]);
  const srcTable = ps.tables[ps.tables.length - 1];
  const mvDestCust = spawnCustomer(ps);
  mvDestCust.pref = "ANY";
  openTableAction(ps, "GREEN", [mvDestCust.id]);
  const destTable = ps.tables[ps.tables.length - 1];
  const srcCount = ps.tables.length;
  r2.render(ps);
  const moveSeat = root2.querySelector(`.seat-move[data-id="${mvSrc.id}"]`) as unknown as HTMLElement;
  assert(!!moveSeat, "席埋め中の客に pick-move 属性がある");
  click(moveSeat);
  assert(!!root2.querySelector("#picker .pk-panel"), "客クリックで移動先ピッカーが開いた");
  const destBtn = root2.querySelector(
    `[data-action="choose"][data-kind="moveDest"][data-table="${destTable.id}"]`,
  ) as unknown as HTMLElement;
  assert(!!destBtn, "希望一致の別卓が移動先候補に出る");
  click(destBtn);
  assert(mvSrc.seatRef?.tableId === destTable.id, "mvSrc が destTable へ移動した");
  assert(ps.tables.length === srcCount - 1, "空になった元卓が撤去された");
  void srcTable;
  console.log("[dom] 客クリック→別卓へ移動 OK");

  // 交代: 満席（本走あり）の卓を作り、断った客は swap ピッカーに出ないことを確認
  const f = spawnCustomer(ps);
  f.pref = "ANY";
  openTableAction(ps, "BLUE", [f.id]);
  const t3 = ps.tables[ps.tables.length - 1];
  // 残り3席を本走で埋めて満席に（canSwap 成立条件）
  while (firstEmptyIdx(t3) >= 0) {
    const st = freeStaff(ps);
    if (!st) break;
    honsoAction(ps, t3.id, firstEmptyIdx(t3), st.id);
  }
  assert(firstEmptyIdx(t3) < 0, "t3 が満席（本走で充填）");
  const yes = spawnCustomer(ps);
  yes.pref = "ANY";
  const no = spawnCustomer(ps);
  no.pref = "ANY";
  no.refusedTables = [t3.id]; // この卓を既に断っている
  r2.render(ps);
  const staffSeat = root2.querySelector(`.seat-swap[data-id="${t3.id}"]`) as unknown as HTMLElement;
  assert(!!staffSeat, "本走席に pick-swap 属性がある");
  click(staffSeat);
  assert(!!root2.querySelector("#picker .pk-panel"), "本走席クリックで交代ピッカーが開いた");
  assert(
    !!root2.querySelector(`[data-action="choose"][data-kind="swap"][data-id="${yes.id}"]`),
    "未拒否の客は交代候補に出る",
  );
  assert(
    !root2.querySelector(`[data-action="choose"][data-kind="swap"][data-id="${no.id}"]`),
    "一度断った客は交代候補から除外（要望6）",
  );
  console.log("[dom] 交代ピッカー＋拒否客の除外 OK");
  root2.remove(); // 次ブロックの #tutorial 等とID衝突しないよう撤去
}

// ---- オンボーディング（WS3）: 初回はチュートリアル → スキップで設定画面 → 2回目は設定直行 ----
{
  dom.window.localStorage.removeItem("moshirasu.profile.v1");
  dom.window.localStorage.removeItem("moshirasu.playerName");
  dom.window.localStorage.removeItem("moshirasu.bestProfit");
  const root3 = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(root3);
  const r3 = createRenderer(root3 as unknown as HTMLElement, () => ({ ok: true }));

  // 初回 showStart → チュートリアルが表示
  r3.showStart();
  const tut = root3.querySelector("#tutorial")!;
  const setup3 = root3.querySelector("#setup")!;
  assert(tut.className.includes("show"), "初回はチュートリアルが表示された");
  assert(!setup3.className.includes("show"), "初回は設定画面はまだ非表示");
  assert(!!root3.querySelector('[data-action="tut-next"]'), "「次へ」ボタンがある");

  // 「次へ」で最終スライドまで → 「はじめる」(tut-done)
  let nextBtn = root3.querySelector('[data-action="tut-next"]') as unknown as HTMLElement;
  let guardT = 0;
  while (nextBtn && guardT < 20) {
    guardT++;
    click(nextBtn);
    nextBtn = root3.querySelector('[data-action="tut-next"]') as unknown as HTMLElement;
  }
  const doneBtn = root3.querySelector('[data-action="tut-done"]') as unknown as HTMLElement;
  assert(!!doneBtn, "最終スライドに「はじめる」がある");
  click(doneBtn);
  assert(!tut.className.includes("show"), "チュートリアルが閉じた");
  assert(setup3.className.includes("show"), "チュートリアル後に設定画面が表示された");
  const profStored = dom.window.localStorage.getItem("moshirasu.profile.v1");
  assert(!!profStored && profStored.includes('"onboarded":true'), "オンボーディング済みが保存された");
  console.log("[dom] 初回オンボーディング→設定画面 OK");

  // 2回目（onboarded=true 状態を読む新しい renderer）→ showStart で設定直行
  const root4 = dom.window.document.createElement("div");
  root3.remove();
  dom.window.document.body.appendChild(root4);
  const r4 = createRenderer(root4 as unknown as HTMLElement, () => ({ ok: true }));
  r4.showStart();
  assert(!root4.querySelector("#tutorial")!.className.includes("show"), "2回目はチュートリアル非表示");
  assert(root4.querySelector("#setup")!.className.includes("show"), "2回目は設定画面直行");
  // 設定画面に「遊び方をもう一度」ボタンがある（再生動線）
  assert(!!root4.querySelector('[data-action="show-tutorial"]'), "設定画面に遊び方再生ボタンがある");
  console.log("[dom] 2回目は設定直行＋遊び方再生動線 OK");
  root4.remove();
}

console.log("\n✅ DOM smoke test passed");

function click(elm: HTMLElement) {
  elm.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
}

function microtask(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
}
