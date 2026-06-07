// ===== state → DOM（唯一の DOM 触る層）=====
// 上部HUD・卓・待ち客・ログ・結果画面を描画。
// 進行バー/我慢ゲージは要素を保持して width だけ更新→CSS transition で滑らか。
// クリックはイベント委譲（data-action）で dispatch に流す。

import { CONFIG, scoreRank } from "./config";
import { rateLabel } from "./economy";
import {
  dayProgress,
  formatClock,
  hanchanProgress,
  isClosed,
  kpis,
  minsUntilLeave,
  patienceRatio,
  yen,
} from "./selectors";
import type { GameState, Rate, Seat, Speed, Table } from "./types";

/** UIから発行されるコマンド。 */
export type Command =
  | { type: "openTable"; rate: Rate; customerIds: number[] }
  | { type: "seat"; customerId: number; tableId: number }
  | { type: "honso"; tableId: number }
  | { type: "swap"; customerId: number; tableId: number }
  | { type: "combine"; a: number; b: number }
  | { type: "setSpeed"; speed: Speed }
  | { type: "togglePause" }
  | { type: "restart" };

export type Dispatch = (cmd: Command) => { ok: boolean; reason?: string };

interface UiState {
  selected: number[]; // 選択中の待ち客ID（順序つき）
  combineFirst: number | null; // 合卓の1卓目
}

export function createRenderer(root: HTMLElement, dispatch: Dispatch) {
  const ui: UiState = { selected: [], combineFirst: null };
  let lastState: GameState | null = null;
  let toastTimer = 0;

  // 永続キー要素のマップ
  const tableCards = new Map<number, HTMLElement>();
  const waitChips = new Map<number, HTMLElement>();
  const logRows = new Map<number, HTMLElement>();

  // ---- 一度だけ構築する骨格 ----
  root.innerHTML = SHELL;
  const el = {
    clock: must("#clock"),
    dayBar: must("#day-bar"),
    revenue: must("#revenue"),
    repBar: must("#rep-bar"),
    repText: must("#rep-text"),
    kpiTables: must("#kpi-tables"),
    kpiWaiting: must("#kpi-waiting"),
    kpiServed: must("#kpi-served"),
    kpiAvgwait: must("#kpi-avgwait"),
    speedBtns: must("#speed-btns"),
    control: must("#control"),
    tables: must("#tables"),
    waiting: must("#waiting"),
    waitingCount: must("#waiting-count"),
    log: must("#log"),
    toast: must("#toast"),
    result: must("#result"),
  };

  function must(sel: string): HTMLElement {
    const e = root.querySelector<HTMLElement>(sel);
    if (!e) throw new Error(`missing element ${sel}`);
    return e;
  }

  // ---- クリック委譲 ----
  root.addEventListener("click", (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target || !lastState) return;
    const action = target.dataset.action!;
    const id = Number(target.dataset.id ?? "0");
    const id2 = Number(target.dataset.id2 ?? "0");

    switch (action) {
      case "select-customer":
        toggleSelect(id);
        rerender();
        break;
      case "open-table": {
        const rate = target.dataset.rate as Rate;
        if (ui.selected.length === 0) return toast("待ち客を選んでから卓を立ててください", false);
        fire({ type: "openTable", rate, customerIds: [...ui.selected] });
        break;
      }
      case "seat":
        if (ui.selected.length === 0) return toast("案内する待ち客を選んでください", false);
        fire({ type: "seat", customerId: ui.selected[0], tableId: id });
        break;
      case "honso":
        fire({ type: "honso", tableId: id });
        break;
      case "swap":
        if (ui.selected.length === 0) return toast("交代させる待ち客を選んでください", false);
        fire({ type: "swap", customerId: ui.selected[0], tableId: id });
        break;
      case "combine-pick":
        if (ui.combineFirst === null) {
          ui.combineFirst = id;
          toast("合卓: もう1卓を選んでください", true);
        } else if (ui.combineFirst === id) {
          ui.combineFirst = null;
        } else {
          fire({ type: "combine", a: ui.combineFirst, b: id });
          ui.combineFirst = null;
        }
        rerender();
        break;
      case "speed":
        fire({ type: "setSpeed", speed: Number(target.dataset.speed) as Speed });
        break;
      case "pause":
        fire({ type: "togglePause" });
        break;
      case "restart":
        fire({ type: "restart" });
        break;
      default:
        void id2;
    }
  });

  function toggleSelect(id: number) {
    const i = ui.selected.indexOf(id);
    if (i >= 0) ui.selected.splice(i, 1);
    else {
      if (ui.selected.length >= 4) ui.selected.shift();
      ui.selected.push(id);
    }
  }

  function fire(cmd: Command) {
    const res = dispatch(cmd);
    if (!res.ok && res.reason) toast(res.reason, false);
    // 着席系コマンド後は選択をクリア
    if (res.ok && (cmd.type === "openTable" || cmd.type === "seat" || cmd.type === "swap")) {
      ui.selected = ui.selected.filter((sid) => stillWaiting(sid));
    }
    rerender();
  }

  function stillWaiting(id: number): boolean {
    return !!lastState?.waiting.some((c) => c.id === id);
  }

  function toast(msg: string, good: boolean) {
    el.toast.textContent = msg;
    el.toast.className = `toast ${good ? "toast-good" : "toast-bad"} show`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      el.toast.className = "toast";
    }, 2600);
  }

  function rerender() {
    if (lastState) render(lastState);
  }

  /** 新しいゲーム開始時にキャッシュとDOMを初期化する（ID再利用の衝突対策）。 */
  function reset() {
    ui.selected = [];
    ui.combineFirst = null;
    for (const [, node] of tableCards) node.remove();
    for (const [, node] of waitChips) node.remove();
    for (const [, node] of logRows) node.remove();
    tableCards.clear();
    waitChips.clear();
    logRows.clear();
    el.tables.innerHTML = "";
    el.waiting.innerHTML = "";
    el.log.innerHTML = "";
    el.result.className = "result-overlay";
  }

  // ---- メイン描画 ----
  function render(state: GameState) {
    lastState = state;

    // 選択から離席済みを除去
    ui.selected = ui.selected.filter((id) => state.waiting.some((c) => c.id === id));

    // HUD
    el.clock.textContent = formatClock(state.clockMin);
    el.dayBar.style.width = `${(dayProgress(state) * 100).toFixed(1)}%`;
    el.revenue.textContent = yen(state.revenue.total);
    el.repBar.style.width = `${state.reputation.toFixed(0)}%`;
    el.repBar.style.background = repColor(state.reputation);
    el.repText.textContent = `評判 ${Math.round(state.reputation)}`;
    const k = kpis(state);
    el.kpiTables.textContent = `${k.tables}/${CONFIG.maxTables}`;
    el.kpiWaiting.textContent = String(k.waiting);
    el.kpiServed.textContent = String(k.served);
    el.kpiAvgwait.textContent = `${k.avgWait.toFixed(0)}分`;
    el.waitingCount.textContent = String(state.waiting.length);

    renderSpeed(state);
    renderControl(state);
    renderTables(state);
    renderWaiting(state);
    renderLog(state);
    renderResult(state);
  }

  function renderSpeed(state: GameState) {
    const speeds: Speed[] = [1, 2, 4];
    const paused = state.speed === 0;
    el.speedBtns.innerHTML =
      `<button data-action="pause" class="spd ${paused ? "spd-on" : ""}">${paused ? "▶ 再開" : "⏸ 停止"}</button>` +
      speeds
        .map(
          (s) =>
            `<button data-action="speed" data-speed="${s}" class="spd ${state.speed === s ? "spd-on" : ""}">${s}x</button>`,
        )
        .join("");
  }

  function renderControl(state: GameState) {
    const n = ui.selected.length;
    const names = ui.selected
      .map((id) => state.waiting.find((c) => c.id === id)?.name ?? "")
      .filter(Boolean)
      .join("・");
    el.control.innerHTML = `
      <div class="ctl-title">卓を立てる</div>
      <div class="ctl-sel">${n > 0 ? `選択中(${n}/4): ${names}` : "待ち客をクリックして選択（最大4人）"}</div>
      <div class="ctl-btns">
        <button data-action="open-table" data-rate="BLUE" class="btn btn-blue" ${n === 0 ? "disabled" : ""}>🔵 ブルー卓(点5)で立てる</button>
        <button data-action="open-table" data-rate="GREEN" class="btn btn-green" ${n === 0 ? "disabled" : ""}>🟢 グリーン卓(点3)で立てる</button>
      </div>
      <div class="ctl-hint">3人以下でも立てて「本走」で店員を入れれば対局できます。点5は場代${yen(CONFIG.gameFeeYen.BLUE)}/半荘、点3は${yen(CONFIG.gameFeeYen.GREEN)}/半荘。</div>
    `;
  }

  function renderTables(state: GameState) {
    const ids = new Set(state.tables.map((t) => t.id));
    // 削除
    for (const [id, node] of tableCards) {
      if (!ids.has(id)) {
        node.remove();
        tableCards.delete(id);
      }
    }
    if (state.tables.length === 0) {
      el.tables.querySelector(".empty-hint")?.remove();
      if (!el.tables.querySelector(".empty-hint")) {
        const hint = document.createElement("div");
        hint.className = "empty-hint";
        hint.textContent = "まだ卓がありません。待ち客が集まったら卓を立てましょう。";
        el.tables.appendChild(hint);
      }
    } else {
      el.tables.querySelector(".empty-hint")?.remove();
    }

    state.tables.forEach((t, idx) => {
      let card = tableCards.get(t.id);
      if (!card) {
        card = document.createElement("div");
        card.dataset.tableCard = String(t.id);
        card.innerHTML = `<div class="thead"></div><div class="track"><div class="bar-fill" data-progressbar></div></div><div class="tbody"></div>`;
        tableCards.set(t.id, card);
        el.tables.appendChild(card);
      }
      // 並び順を維持
      if (el.tables.children[idx] !== card) el.tables.appendChild(card);
      card.className = `table-card ${t.rate === "BLUE" ? "tc-blue" : "tc-green"}`;
      updateTableCard(card, state, t, idx + 1);
    });
  }

  function updateTableCard(card: HTMLElement, state: GameState, t: Table, no: number) {
    const thead = card.querySelector<HTMLElement>(".thead")!;
    const bar = card.querySelector<HTMLElement>("[data-progressbar]")!;
    const tbody = card.querySelector<HTMLElement>(".tbody")!;

    thead.innerHTML = `
      <span class="tc-no">卓#${no}</span>
      <span class="tc-rate">${t.rate === "BLUE" ? "🔵 点5" : "🟢 点3"}</span>
      <span class="tc-status">${statusLabel(t)}</span>
      <span class="tc-count">${t.progress.hanchanCount}半荘</span>`;
    bar.style.width = `${(hanchanProgress(t) * 100).toFixed(1)}%`;
    bar.style.background = t.rate === "BLUE" ? "var(--blue)" : "var(--green)";

    const playing = t.progress.status === "EAST" || t.progress.status === "SOUTH";
    const waitingStart = t.progress.status === "WAITING_TO_START";

    const seatsHtml = t.seats.map((s) => seatHtml(state, s)).join("");

    // アクションボタン
    const hasEmpty = t.seats.some((s) => s.occupant.kind === "EMPTY");
    const hasHonsoSeat = t.seats.some((s) => s.occupant.kind === "STAFF");
    const custCount = t.seats.filter((s) => s.occupant.kind === "CUSTOMER").length;
    const freeStaff = state.staff.some((s) => !s.busy);
    const btns: string[] = [];
    if (waitingStart && hasEmpty) {
      btns.push(`<button data-action="seat" data-id="${t.id}" class="mini">案内</button>`);
      if (custCount >= 1 && freeStaff)
        btns.push(`<button data-action="honso" data-id="${t.id}" class="mini mini-staff">本走</button>`);
    }
    if (playing && hasHonsoSeat && t.progress.status === "EAST") {
      btns.push(`<button data-action="swap" data-id="${t.id}" class="mini mini-swap">交代</button>`);
    }
    if (waitingStart) {
      const picked = ui.combineFirst === t.id;
      btns.push(
        `<button data-action="combine-pick" data-id="${t.id}" class="mini ${picked ? "mini-on" : ""}">${picked ? "合卓:選択中" : "合卓"}</button>`,
      );
    }

    tbody.innerHTML = `<div class="seats">${seatsHtml}</div><div class="tc-actions">${btns.join("")}</div>`;
  }

  function seatHtml(state: GameState, s: Seat): string {
    if (s.occupant.kind === "EMPTY") {
      return `<div class="seat seat-empty">空席</div>`;
    }
    if (s.occupant.kind === "STAFF") {
      const st = state.staff.find((x) => x.id === (s.occupant as { staffId: number }).staffId);
      return `<div class="seat seat-staff"><div class="seat-name">🧑‍💼 ${st?.name ?? "店員"}</div><div class="seat-badge">本走</div></div>`;
    }
    const c = state.customers.get(s.occupant.customerId);
    if (!c) return `<div class="seat seat-empty">空席</div>`;
    const call = s.call
      ? `<span class="call ${s.call === "LASTHAN" ? "call-last" : "call-mosh"}">${s.call === "LASTHAN" ? "ラスハン" : "モシラス"}</span>`
      : "";
    const low = c.bankroll <= c.startBankroll * 0.3 ? "seat-low" : "";
    return `<div class="seat seat-cust ${low}">
      <div class="seat-name">${c.emoji} ${c.name}</div>
      <div class="seat-meta">${yen(c.bankroll)}</div>
      ${call}
    </div>`;
  }

  function renderWaiting(state: GameState) {
    const ids = new Set(state.waiting.map((c) => c.id));
    for (const [id, node] of waitChips) {
      if (!ids.has(id)) {
        node.remove();
        waitChips.delete(id);
      }
    }
    state.waiting.forEach((c, idx) => {
      let chip = waitChips.get(c.id);
      if (!chip) {
        chip = document.createElement("div");
        chip.dataset.action = "select-customer";
        chip.dataset.id = String(c.id);
        chip.innerHTML = `<div class="wbody"></div><div class="track"><div class="bar-fill" data-patience></div></div>`;
        waitChips.set(c.id, chip);
        el.waiting.appendChild(chip);
      }
      if (el.waiting.children[idx] !== chip) el.waiting.appendChild(chip);

      const selected = ui.selected.includes(c.id);
      const pr = patienceRatio(c);
      chip.className = `wchip ${selected ? "selected-ring" : ""} ${pr > 0.75 ? "wchip-urgent" : ""}`;
      const prefBadge =
        c.pref === "BLUE"
          ? `<span class="pref pref-blue">点5</span>`
          : c.pref === "GREEN"
            ? `<span class="pref pref-green">点3</span>`
            : `<span class="pref pref-any">どちらでも</span>`;
      const leaveIn = minsUntilLeave(state, c);
      chip.querySelector<HTMLElement>(".wbody")!.innerHTML = `
        <div class="w-top">${c.emoji} <span class="w-name">${c.name}</span> ${prefBadge}</div>
        <div class="w-meta">資金${yen(c.bankroll)}・帰宅まで${leaveIn}分</div>
        <div class="w-wait ${pr > 0.75 ? "pulse-warn" : ""}">待ち ${Math.round(c.waitedMin)}/${c.patienceMin}分</div>`;
      const pbar = chip.querySelector<HTMLElement>("[data-patience]")!;
      pbar.style.width = `${(pr * 100).toFixed(1)}%`;
      pbar.style.background = pr > 0.75 ? "var(--red)" : pr > 0.45 ? "var(--amber)" : "#64748b";
    });
    if (state.waiting.length === 0) {
      if (!el.waiting.querySelector(".empty-hint")) {
        const hint = document.createElement("div");
        hint.className = "empty-hint small";
        hint.textContent = "待ち客なし";
        el.waiting.appendChild(hint);
      }
    } else {
      el.waiting.querySelector(".empty-hint")?.remove();
    }
  }

  function renderLog(state: GameState) {
    // 新しい順。新規分のみ prepend。
    const known = logRows;
    for (const entry of [...state.eventLog].reverse()) {
      if (known.has(entry.id)) continue;
      const row = document.createElement("div");
      row.className = `log-row log-in log-${entry.kind.toLowerCase()}`;
      row.innerHTML = `<span class="log-time">${formatClock(entry.atMin)}</span><span class="log-text">${entry.text}</span>`;
      known.set(entry.id, row);
      el.log.prepend(row);
    }
    // 上限を超えた古い行を除去
    const validIds = new Set(state.eventLog.map((e) => e.id));
    for (const [id, node] of known) {
      if (!validIds.has(id)) {
        node.remove();
        known.delete(id);
      }
    }
  }

  function renderResult(state: GameState) {
    if (!isClosed(state)) {
      el.result.className = "result-overlay";
      return;
    }
    const k = kpis(state);
    const { rank, comment } = scoreRank(state.revenue.total);
    el.result.className = "result-overlay show";
    el.result.innerHTML = `
      <div class="result-card">
        <div class="result-rank rank-${rank}">${rank}</div>
        <div class="result-title">本日の営業終了</div>
        <div class="result-comment">${comment}</div>
        <div class="result-grid">
          <div><span>総売上</span><b>${yen(state.revenue.total)}</b></div>
          <div><span>うち場代</span><b>${yen(state.revenue.gameFee)}</b></div>
          <div><span>接客した客数</span><b>${k.served}人</b></div>
          <div><span>打たれた半荘</span><b>${state.stats.hanchanPlayed}回</b></div>
          <div><span>満足して帰った</span><b>${state.stats.satisfied}人</b></div>
          <div><span>怒って帰った</span><b class="bad">${state.stats.rageQuits}人</b></div>
          <div><span>飛んで離席</span><b class="bad">${state.stats.busts}人</b></div>
          <div><span>平均待ち時間</span><b>${k.avgWait.toFixed(0)}分</b></div>
          <div><span>同時待ちピーク</span><b>${state.stats.peakWaiting}人</b></div>
          <div><span>最終評判</span><b>${Math.round(state.reputation)}</b></div>
        </div>
        <button data-action="restart" class="btn btn-blue result-restart">🔁 もう一度開店する</button>
      </div>`;
  }

  return { render, reset };
}

// ---- 純ヘルパー ----

function statusLabel(t: Table): string {
  switch (t.progress.status) {
    case "WAITING_TO_START":
      return t.seats.every((s) => s.occupant.kind !== "EMPTY") ? "まもなく開始" : "席埋め中";
    case "EAST":
      return "東場";
    case "SOUTH":
      return "南場";
    case "SETTLING":
      return "精算中";
    default:
      return "";
  }
}

function repColor(r: number): string {
  if (r >= 66) return "var(--green)";
  if (r >= 33) return "var(--amber)";
  return "var(--red)";
}

void rateLabel; // 予約（将来のツールチップ用）

// ---- 骨格マークアップ ----
const SHELL = `
<div class="hud">
  <div class="hud-left">
    <div class="clock-wrap"><span class="clock-label">店内時刻</span><span id="clock" class="clock">12:00</span></div>
    <div class="day-track"><div id="day-bar" class="bar-fill day-bar"></div></div>
  </div>
  <div class="hud-mid">
    <div class="rev-wrap"><span class="rev-label">本日の売上</span><span id="revenue" class="rev">¥0</span></div>
    <div class="rep-wrap">
      <div id="rep-text" class="rep-text">評判 70</div>
      <div class="rep-track"><div id="rep-bar" class="bar-fill rep-bar"></div></div>
    </div>
  </div>
  <div class="hud-right">
    <div class="kpis">
      <div class="kpi"><span>卓</span><b id="kpi-tables">0/4</b></div>
      <div class="kpi"><span>待ち</span><b id="kpi-waiting">0</b></div>
      <div class="kpi"><span>接客</span><b id="kpi-served">0</b></div>
      <div class="kpi"><span>平均待ち</span><b id="kpi-avgwait">0分</b></div>
    </div>
    <div id="speed-btns" class="speed-btns"></div>
  </div>
</div>

<div class="main">
  <section class="col col-tables">
    <h2 class="col-h">卓（フロア）</h2>
    <div id="control" class="control"></div>
    <div id="tables" class="tables"></div>
  </section>
  <section class="col col-waiting">
    <h2 class="col-h">待ち客 <span id="waiting-count" class="badge">0</span></h2>
    <div id="waiting" class="waiting thin-scroll"></div>
  </section>
  <section class="col col-log">
    <h2 class="col-h">イベントログ</h2>
    <div id="log" class="log thin-scroll"></div>
  </section>
</div>

<div id="toast" class="toast"></div>
<div id="result" class="result-overlay"></div>
`;
