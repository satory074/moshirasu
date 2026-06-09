// ===== state → DOM（唯一の DOM 触る層）=====
// 上部HUD・卓・待ち客・ログ・結果画面を描画。
// 進行バー/我慢ゲージは要素を保持して width だけ更新→CSS transition で滑らか。
// クリックはイベント委譲（data-action）で dispatch に流す。

import { CONFIG, scoreRank } from "./config";
import { rateLabel } from "./economy";
import {
  buildScoreEntry,
  createRankingStore,
  percentile,
  type RankingStore,
  type ScoreEntry,
} from "./ranking";
import {
  ACHIEVEMENTS,
  applyDayResult,
  buildDayResult,
  loadProfile,
  saveProfile,
  type Achievement,
  type PlayerProfile,
} from "./profile";
import { canChangeRate, firstEmptyIdx, hasEmptySeat } from "./tables";
import {
  dayProgress,
  formatClock,
  hanchanProgress,
  isClosed,
  kpis,
  kyokuLabel,
  minsUntilLeave,
  patienceRatio,
  yen,
} from "./selectors";
import type { GameState, Pref, Rate, Seat, Table } from "./types";

/** UIから発行されるコマンド。 */
export type Command =
  | { type: "openTable"; rate: Rate; customerIds: number[] }
  | { type: "seat"; customerId: number; tableId: number; seatIdx: number }
  | { type: "honso"; tableId: number; seatIdx: number; staffId: number }
  | { type: "swap"; customerId: number; tableId: number; seatIdx: number }
  | { type: "move"; customerId: number; tableId: number; seatIdx: number }
  | { type: "combine"; a: number; b: number }
  | { type: "changeRate"; tableId: number }
  | { type: "startGame"; staffCount: number }
  | { type: "advance" }
  | { type: "restart" };

export type Dispatch = (cmd: Command) => { ok: boolean; reason?: string };

interface UiState {
  selected: number[]; // 選択中の待ち客ID（順序つき）
  combineFirst: number | null; // 合卓の1卓目
  // チュートリアル（オンボーディング）の現在スライド。null なら非表示。
  tutorialStep: number | null;
  // 席クリックで開くアテンド/交代/移動ピッカーの対象。null なら閉じている。
  // seat/swap は対象「席」起点、move は移動させる「客」起点（移動先卓をピッカーで選ぶ）。
  pickSeat:
    | { mode: "seat" | "swap"; tableId: number; seatIdx: number }
    | { mode: "move"; customerId: number }
    | null;
}

/** 開店前設定（ゲーム状態とは独立した transient UI 状態）。 */
interface SetupState {
  staffCount: number;
}

/** リザルトのランキング表示状態（state には載らない外部データ）。 */
interface RankingView {
  builtForClosed: boolean; // この閉店セッションでカードを構築済みか
  loaded: boolean; // fetchTop 完了したか
  entries: ScoreEntry[]; // 表示中のTOP
  submittedId: string | null; // 今回登録したエントリID（ハイライト用）
  isNewBest: boolean; // 自己ベスト更新か
}

export function createRenderer(root: HTMLElement, dispatch: Dispatch) {
  const ui: UiState = { selected: [], combineFirst: null, pickSeat: null, tutorialStep: null };
  const setupState: SetupState = { staffCount: CONFIG.staffCount };
  // 永続プロフィール（キャリア記録＋称号＋オンボーディング済みフラグ）。起動時に一度読む。
  let profile: PlayerProfile = loadProfile();
  // 今回の閉店で新たに解放した称号（結果画面のハイライト用・transient）。
  let newAchievements: Achievement[] = [];
  const rankingStore: RankingStore = createRankingStore();
  const rankingView: RankingView = {
    builtForClosed: false,
    loaded: false,
    entries: [],
    submittedId: null,
    isNewBest: false,
  };
  let lastState: GameState | null = null;
  let toastTimer = 0;

  // 永続キー要素のマップ
  const tableCards = new Map<number, HTMLElement>();
  const waitChips = new Map<number, HTMLElement>();
  const logRows = new Map<number, HTMLElement>();
  // アテンド/交代ピッカーのオーバーレイ（必要時に root 配下へ生成）。
  let pickerEl: HTMLElement | null = null;

  // ---- 一度だけ構築する骨格 ----
  root.innerHTML = SHELL;
  const el = {
    clock: must("#clock"),
    dayBar: must("#day-bar"),
    revenue: must("#revenue"),
    profit: must("#profit"),
    wages: must("#wages"),
    repBar: must("#rep-bar"),
    repText: must("#rep-text"),
    kpiTables: must("#kpi-tables"),
    kpiWaiting: must("#kpi-waiting"),
    kpiServed: must("#kpi-served"),
    kpiAvgwait: must("#kpi-avgwait"),
    staff: must("#staff"),
    advanceWrap: must("#advance-wrap"),
    advanceBar: must("#advance-bar"),
    control: must("#control"),
    tables: must("#tables"),
    waiting: must("#waiting"),
    waitingCount: must("#waiting-count"),
    log: must("#log"),
    toast: must("#toast"),
    result: must("#result"),
    setup: must("#setup"),
    tutorial: must("#tutorial"),
  };

  function must(sel: string): HTMLElement {
    const e = root.querySelector<HTMLElement>(sel);
    if (!e) throw new Error(`missing element ${sel}`);
    return e;
  }

  // ---- クリック委譲 ----
  root.addEventListener("click", (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    const action = target.dataset.action!;

    // 開店前設定の操作は lastState（ゲーム状態）が無くても動く必要がある。
    if (action === "setup-dec" || action === "setup-inc") {
      adjustSetup(action === "setup-inc" ? 1 : -1);
      renderSetup();
      return;
    }
    if (action === "start-game") {
      fire({ type: "startGame", staffCount: setupState.staffCount });
      return;
    }
    // チュートリアル（オンボーディング）操作も lastState 不要で動く。
    if (action === "tut-next") {
      ui.tutorialStep = Math.min(TUTORIAL_SLIDES.length - 1, (ui.tutorialStep ?? 0) + 1);
      renderTutorial();
      return;
    }
    if (action === "tut-prev") {
      ui.tutorialStep = Math.max(0, (ui.tutorialStep ?? 0) - 1);
      renderTutorial();
      return;
    }
    if (action === "tut-done") {
      finishTutorial();
      return;
    }
    if (action === "show-tutorial") {
      showTutorial();
      return;
    }

    if (!lastState) return;
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
      case "pick-seat":
        ui.pickSeat = { tableId: id, seatIdx: Number(target.dataset.seat ?? "0"), mode: "seat" };
        rerender();
        break;
      case "pick-swap":
        ui.pickSeat = { tableId: id, seatIdx: Number(target.dataset.seat ?? "0"), mode: "swap" };
        rerender();
        break;
      case "pick-move":
        ui.pickSeat = { mode: "move", customerId: id };
        rerender();
        break;
      case "pick-close":
        ui.pickSeat = null;
        rerender();
        break;
      case "choose": {
        const ps = ui.pickSeat;
        if (!ps) break;
        const kind = target.dataset.kind;
        ui.pickSeat = null;
        if (ps.mode === "move") {
          // 客起点の移動: 移動先卓/席は候補行の data 属性から読む。
          if (kind === "moveDest") {
            fire({
              type: "move",
              customerId: ps.customerId,
              tableId: Number(target.dataset.table ?? "0"),
              seatIdx: Number(target.dataset.seat ?? "0"),
            });
          }
        } else if (kind === "cust") {
          fire({ type: "seat", customerId: id, tableId: ps.tableId, seatIdx: ps.seatIdx });
        } else if (kind === "staff") {
          fire({ type: "honso", tableId: ps.tableId, seatIdx: ps.seatIdx, staffId: id });
        } else if (kind === "move") {
          fire({ type: "move", customerId: id, tableId: ps.tableId, seatIdx: ps.seatIdx });
        } else if (kind === "swap") {
          fire({ type: "swap", customerId: id, tableId: ps.tableId, seatIdx: ps.seatIdx });
        }
        break;
      }
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
      case "change-rate":
        fire({ type: "changeRate", tableId: id });
        break;
      case "submit-score":
        void onSubmitScore();
        break;
      case "advance":
        fire({ type: "advance" });
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
    ui.pickSeat = null;
    newAchievements = [];
    pickerEl?.remove();
    pickerEl = null;
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
    el.result.innerHTML = "";
    // ランキング表示状態をリセット（次の閉店で作り直す）。setupState は保持。
    rankingView.builtForClosed = false;
    rankingView.loaded = false;
    rankingView.entries = [];
    rankingView.submittedId = null;
    rankingView.isNewBest = false;
  }

  // ---- 開店前設定（店員数）----
  function adjustSetup(delta: number) {
    const min = CONFIG.staffMin;
    const max = CONFIG.maxTables * 4; // 全卓・全席を本走で埋められる上限
    setupState.staffCount = Math.max(min, Math.min(max, setupState.staffCount + delta));
  }

  function renderSetup() {
    const n = setupState.staffCount;
    const min = CONFIG.staffMin;
    const max = CONFIG.maxTables * 4;
    const hours = (CONFIG.closeMin - CONFIG.openMin) / 60;
    const estWage = Math.round(n * CONFIG.wagePerHourYen * hours);
    el.setup.innerHTML = `
      <div class="setup-card">
        <div class="setup-title">🀄 開店準備</div>
        ${careerSummaryHtml()}
        <div class="setup-lead">
          本走に入れる<b>店員の数</b>を決めて開店します。多いほど卓を埋めやすい一方、
          時給${yen(CONFIG.wagePerHourYen)}/人の人件費が利益を圧迫します。<br>
          <b>店員数は開店後は変更できません。</b>
        </div>
        <div class="setup-stepper">
          <button data-action="setup-dec" class="setup-step-btn" ${n <= min ? "disabled" : ""} aria-label="減らす">−</button>
          <div class="setup-count"><b>${n}</b><span>人</span></div>
          <button data-action="setup-inc" class="setup-step-btn" ${n >= max ? "disabled" : ""} aria-label="増やす">＋</button>
        </div>
        <div class="setup-range">選択範囲 ${min}〜${max}人</div>
        <div class="setup-wage">想定人件費（約${hours.toFixed(1)}時間営業）: 約 ${yen(estWage)}</div>
        <button data-action="start-game" class="btn btn-blue setup-start">▶ ${n}人で開店する</button>
        <button data-action="show-tutorial" class="setup-howto">📖 遊び方をもう一度</button>
      </div>`;
    el.setup.className = "setup-overlay show";
  }

  /** 設定画面に出すキャリア要約（営業実績がある時のみ）。 */
  function careerSummaryHtml(): string {
    if (profile.gamesPlayed <= 0) return "";
    const best = profile.bestProfit !== null ? yen(profile.bestProfit) : "—";
    return `
      <div class="setup-career">
        <span>営業 <b>${profile.gamesPlayed}</b>日</span>
        <span>自己ベスト <b>${best}</b>${profile.bestRank ? `（${profile.bestRank}）` : ""}</span>
        <span>称号 <b>${profile.unlockedAchievements.length}</b>/${ACHIEVEMENTS.length}</span>
      </div>`;
  }

  function showSetup() {
    renderSetup();
  }

  function hideSetup() {
    el.setup.className = "setup-overlay";
  }

  // ---- オンボーディング（チュートリアル）----
  /** 起動時の入口: 未オンボーディングならチュートリアル、済なら設定画面。 */
  function showStart() {
    if (!profile.onboarded) showTutorial();
    else showSetup();
  }

  function showTutorial() {
    ui.tutorialStep = 0;
    renderTutorial();
  }

  function renderTutorial() {
    const step = ui.tutorialStep ?? 0;
    const slide = TUTORIAL_SLIDES[step];
    const last = step === TUTORIAL_SLIDES.length - 1;
    const dots = TUTORIAL_SLIDES.map((_, i) => `<span class="tut-dot ${i === step ? "tut-dot-on" : ""}"></span>`).join("");
    el.tutorial.innerHTML = `
      <div class="tutorial-card">
        <div class="tut-emoji">${slide.emoji}</div>
        <div class="tut-title">${slide.title}</div>
        <div class="tut-body">${slide.body}</div>
        <div class="tut-dots">${dots}</div>
        <div class="tut-nav">
          ${step > 0 ? `<button data-action="tut-prev" class="btn btn-green tut-prev">← 戻る</button>` : `<button data-action="tut-done" class="tut-skip">スキップ</button>`}
          ${last
            ? `<button data-action="tut-done" class="btn btn-blue tut-start">▶ はじめる</button>`
            : `<button data-action="tut-next" class="btn btn-blue tut-next">次へ →</button>`}
        </div>
      </div>`;
    el.tutorial.className = "tutorial-overlay show";
  }

  /** チュートリアルを閉じる。初回ならオンボーディング済みにして保存し、設定画面へ。 */
  function finishTutorial() {
    ui.tutorialStep = null;
    el.tutorial.className = "tutorial-overlay";
    if (!profile.onboarded) {
      profile = { ...profile, onboarded: true };
      saveProfile(profile);
    }
    showSetup();
  }

  // ---- メイン描画 ----
  function render(state: GameState) {
    lastState = state;

    // 選択から離席済みを除去
    ui.selected = ui.selected.filter((id) => state.waiting.some((c) => c.id === id));

    // HUD
    const k = kpis(state);
    el.clock.textContent = formatClock(state.clockMin);
    el.dayBar.style.width = `${(dayProgress(state) * 100).toFixed(1)}%`;
    el.profit.textContent = yen(k.profit);
    el.profit.style.color = k.profit >= 0 ? "var(--amber-ink)" : "var(--red)";
    el.revenue.textContent = yen(k.revenue);
    el.wages.textContent = `-${yen(k.wages)}`;
    el.repBar.style.width = `${state.reputation.toFixed(0)}%`;
    el.repBar.style.background = repColor(state.reputation);
    el.repText.textContent = `評判 ${Math.round(state.reputation)}`;
    el.kpiTables.textContent = `${k.tables}/${CONFIG.maxTables}`;
    el.kpiWaiting.textContent = String(k.waiting);
    el.kpiServed.textContent = String(k.served);
    el.kpiAvgwait.textContent = `${k.avgWait.toFixed(0)}分`;
    el.waitingCount.textContent = String(state.waiting.length);

    renderStaff(state);
    renderAdvance(state);
    renderControl(state);
    renderTables(state);
    renderWaiting(state);
    renderLog(state);
    renderResult(state);
    renderPicker(state);
  }

  /** 空席/本走席クリックで開くアテンド・交代ピッカー。候補をクリックして実行。 */
  function renderPicker(state: GameState) {
    const ps = ui.pickSeat;
    // 客起点の移動ピッカー（移動させる客は固定、移動先卓を選ぶ）。
    if (ps?.mode === "move") {
      renderMovePicker(state, ps.customerId);
      return;
    }
    // 対象席が無効になっていたら閉じる。
    let valid = false;
    let table: Table | undefined;
    if (ps) {
      table = state.tables.find((t) => t.id === ps.tableId);
      const seat = table?.seats[ps.seatIdx];
      if (table && seat && table.progress.status !== "SETTLING") {
        if (ps.mode === "seat") valid = seat.occupant.kind === "EMPTY";
        else valid = seat.occupant.kind === "STAFF";
      }
    }
    if (!ps || !valid || !table) {
      ui.pickSeat = null;
      pickerEl?.remove();
      pickerEl = null;
      return;
    }

    if (!pickerEl) {
      pickerEl = document.createElement("div");
      pickerEl.id = "picker";
      root.appendChild(pickerEl);
    }

    const rateLabelStr = table.rate === "BLUE" ? "点5(ブルー)" : "点3(グリーン)";
    const rows: string[] = [];

    if (ps.mode === "seat") {
      // 1) 待ち客（希望一致）
      for (const c of state.waiting) {
        if (!prefAllowsRate(c.pref, table.rate)) continue;
        rows.push(candidateRow("cust", c.id, `${c.emoji} ${c.name}`, prefBadgeHtml(c.pref), `待ち客・資金${yen(c.bankroll)}`));
      }
      // 2) 空き店員
      for (const st of state.staff) {
        if (st.busy) continue;
        rows.push(candidateRow("staff", st.id, `🧑‍💼 ${st.name}`, `<span class="pk-badge pk-staff">本走</span>`, "店員（場代なし）"));
      }
      // 3) 別卓（開始待ち）の着席客で希望一致 → 移動
      for (const t2 of state.tables) {
        if (t2.id === table.id || t2.progress.status !== "WAITING_TO_START") continue;
        const no2 = state.tables.indexOf(t2) + 1;
        for (const seat of t2.seats) {
          if (seat.occupant.kind !== "CUSTOMER") continue;
          const c = state.customers.get(seat.occupant.customerId);
          if (!c || !prefAllowsRate(c.pref, table.rate)) continue;
          rows.push(candidateRow("move", c.id, `${c.emoji} ${c.name}`, prefBadgeHtml(c.pref), `卓#${no2} から移動`));
        }
      }
    } else {
      // swap: 待ち客（希望一致・この卓を断っていない）
      for (const c of state.waiting) {
        if (!prefAllowsRate(c.pref, table.rate)) continue;
        if (c.refusedTables.includes(table.id)) continue;
        rows.push(candidateRow("swap", c.id, `${c.emoji} ${c.name}`, prefBadgeHtml(c.pref), `待ち客・資金${yen(c.bankroll)}`));
      }
    }

    const title =
      ps.mode === "seat"
        ? `空席に案内（${rateLabelStr}）`
        : `本走と交代（${rateLabelStr}・受諾は確率）`;
    const body =
      rows.length > 0
        ? `<div class="pk-list">${rows.join("")}</div>`
        : `<div class="pk-empty">該当する客・店員がいません</div>`;
    pickerEl.innerHTML = `
      <div class="pk-backdrop" data-action="pick-close"></div>
      <div class="pk-panel" role="dialog">
        <div class="pk-head">
          <span class="pk-title">${title}</span>
          <button class="pk-close" data-action="pick-close" aria-label="閉じる">✕</button>
        </div>
        ${body}
      </div>`;
  }

  /** 客起点の移動ピッカー。移動させる客は固定で、希望一致・開始待ち・空席ありの別卓を移動先候補に並べる。 */
  function renderMovePicker(state: GameState, customerId: number) {
    const c = state.customers.get(customerId);
    const src = c?.seatRef ? state.tables.find((t) => t.id === c.seatRef!.tableId) : undefined;
    // 移動元の客・卓が無効化（離席/開始済み等）していたら閉じる。
    if (!c || c.status !== "SEATED" || !src || src.progress.status !== "WAITING_TO_START") {
      ui.pickSeat = null;
      pickerEl?.remove();
      pickerEl = null;
      return;
    }

    if (!pickerEl) {
      pickerEl = document.createElement("div");
      pickerEl.id = "picker";
      root.appendChild(pickerEl);
    }

    const rows: string[] = [];
    for (const t of state.tables) {
      if (t.id === src.id || t.progress.status !== "WAITING_TO_START") continue;
      if (!hasEmptySeat(t) || !prefAllowsRate(c.pref, t.rate)) continue;
      const no = state.tables.indexOf(t) + 1;
      const rateStr = t.rate === "BLUE" ? "点5(ブルー)" : "点3(グリーン)";
      const empties = t.seats.filter((s) => s.occupant.kind === "EMPTY").length;
      rows.push(destRow(t.id, firstEmptyIdx(t), `卓#${no}`, prefBadgeHtml(c.pref), `${rateStr}・空席${empties}`));
    }

    const body =
      rows.length > 0
        ? `<div class="pk-list">${rows.join("")}</div>`
        : `<div class="pk-empty">移動できる別卓がありません</div>`;
    pickerEl.innerHTML = `
      <div class="pk-backdrop" data-action="pick-close"></div>
      <div class="pk-panel" role="dialog">
        <div class="pk-head">
          <span class="pk-title">${c.emoji} ${c.name} の移動先を選択</span>
          <button class="pk-close" data-action="pick-close" aria-label="閉じる">✕</button>
        </div>
        ${body}
      </div>`;
  }

  function candidateRow(
    kind: "cust" | "staff" | "move" | "swap",
    id: number,
    name: string,
    badge: string,
    meta: string,
  ): string {
    return `<button class="pk-row" data-action="choose" data-kind="${kind}" data-id="${id}">
      <span class="pk-name">${name} ${badge}</span>
      <span class="pk-meta">${meta}</span>
    </button>`;
  }

  /** 移動先卓を表す候補行。移動先の卓ID/席Idxを data 属性に持つ。 */
  function destRow(tableId: number, seatIdx: number, name: string, badge: string, meta: string): string {
    return `<button class="pk-row" data-action="choose" data-kind="moveDest" data-table="${tableId}" data-seat="${seatIdx}">
      <span class="pk-name">${name} ${badge}</span>
      <span class="pk-meta">${meta}</span>
    </button>`;
  }

  function renderStaff(state: GameState) {
    const total = state.staff.length;
    const busy = state.staff.filter((s) => s.busy).length;
    const free = total - busy;
    // 店員数は開店前に確定済み（進行中の増員は不可）。情報表示のみ。
    el.staff.innerHTML = `
      <div class="staff-info">
        <span class="staff-emoji">🧑‍💼</span>
        <span class="staff-count">店員 <b>${total}</b>人</span>
        <span class="staff-detail">本走中 ${busy} ・ 空き ${free}</span>
        <span class="staff-wage">人件費 ${yen(state.expenses.wages)}</span>
      </div>`;
  }

  function renderAdvance(state: GameState) {
    const closed = isClosed(state);
    const busy = state.advancing;
    const label = busy ? "⏳ 進行中…" : "▶ 次のイベントへ";
    // 同じボタンを HUD内（PC）と画面下部固定バー（スマホ）の両方に出す。
    // CSS のブレークポイントでどちらか一方だけ表示する。
    const btn = closed
      ? ""
      : `<button data-action="advance" class="btn-advance" ${busy ? "disabled" : ""}>${label}</button>`;
    el.advanceWrap.innerHTML = btn;
    el.advanceBar.innerHTML = btn;
  }

  function renderControl(state: GameState) {
    const n = ui.selected.length;
    const names = ui.selected
      .map((id) => state.waiting.find((c) => c.id === id)?.name ?? "")
      .filter(Boolean)
      .join("・");
    const step1Active = n === 0;
    const step2Active = n > 0;
    // 待ち客がいるのに未選択なら、最初の操作（①）に注意を促す
    const attention = n === 0 && state.waiting.length > 0 ? "step-attention" : "";
    el.control.innerHTML = `
      <div class="ctl-title">卓を立てる</div>
      <div class="ctl-step ${step1Active ? "step-active" : ""} ${attention}">
        <div class="step-num">1</div>
        <div class="step-body">
          <div class="step-label">待ち客をタップで選択（最大4人）</div>
          <div class="step-sel">${n > 0 ? `選択中(${n}/4): ${names}` : ""}</div>
        </div>
      </div>
      <div class="ctl-step ${step2Active ? "step-active" : ""}">
        <div class="step-num">2</div>
        <div class="step-body">
          <div class="step-label">卓のレートを選ぶ</div>
          <div class="ctl-btns">
            <button data-action="open-table" data-rate="BLUE" class="btn btn-blue" ${n === 0 ? `disabled title="先に待ち客を選択してください"` : ""}>🔵 ブルー卓(点5)で立てる</button>
            <button data-action="open-table" data-rate="GREEN" class="btn btn-green" ${n === 0 ? `disabled title="先に待ち客を選択してください"` : ""}>🟢 グリーン卓(点3)で立てる</button>
          </div>
        </div>
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

    const waitingStart = t.progress.status === "WAITING_TO_START";

    // アクション判定
    const hasEmpty = t.seats.some((s) => s.occupant.kind === "EMPTY");
    const hasHonsoSeat = t.seats.some((s) => s.occupant.kind === "STAFF");
    // 交代: 東場、または「まもなく開始（満席・本走あり）」で可能。本走席クリックで起動。
    const canSwap = hasHonsoSeat && (t.progress.status === "EAST" || (waitingStart && !hasEmpty));

    const seatsHtml = t.seats
      .map((s, i) => seatHtml(state, t, s, i, waitingStart, canSwap))
      .join("");

    const btns: string[] = [];
    if (waitingStart) {
      const picked = ui.combineFirst === t.id;
      btns.push(
        `<button data-action="combine-pick" data-id="${t.id}" class="mini ${picked ? "mini-on" : ""}">🔗 ${picked ? "合卓:選択中" : "合卓"}</button>`,
      );
      // 客が全員「どちらでも」ならレート切替を提示。
      if (canChangeRate(state, t)) {
        const to = t.rate === "BLUE" ? "🟢 点3へ" : "🔵 点5へ";
        btns.push(`<button data-action="change-rate" data-id="${t.id}" class="mini">🔁 ${to}</button>`);
      }
    }

    // 「今この卓で何ができるか」を一言で示す（発見性・時間限定アクションの明示）
    let hint = "";
    if (waitingStart && hasEmpty) {
      hint = `<div class="tc-hint">💡 空席あり — 空席をクリックして客・店員を入れて開始（別卓の客も移動可）</div>`;
    } else if (canSwap && waitingStart) {
      hint = `<div class="tc-hint tc-hint-time">⏳ 開始前に本走席をクリックで待ち客に交代できます</div>`;
    } else if (canSwap) {
      hint = `<div class="tc-hint tc-hint-time">⏳ 東場のうちだけ本走席クリックで待ち客に交代できます</div>`;
    }

    tbody.innerHTML = `<div class="seats">${seatsHtml}</div>${hint}<div class="tc-actions">${btns.join("")}</div>`;
  }

  function seatHtml(
    state: GameState,
    t: Table,
    s: Seat,
    seatIdx: number,
    waitingStart = false,
    canSwap = false,
  ): string {
    if (s.occupant.kind === "EMPTY") {
      // 開始待ちの空席はクリックでアテンドピッカーを開く。
      return waitingStart
        ? `<div class="seat seat-empty seat-pick" data-action="pick-seat" data-id="${t.id}" data-seat="${seatIdx}">＋ 空席<small>クリックで案内</small></div>`
        : `<div class="seat seat-empty">空席</div>`;
    }
    const dealer = s.isDealer ? `<span class="seat-dealer" title="親">親</span>` : "";
    const pts = `<div class="seat-pts">${s.points.toLocaleString()}点</div>`;
    if (s.occupant.kind === "STAFF") {
      const st = state.staff.find((x) => x.id === (s.occupant as { staffId: number }).staffId);
      // 交代可能なら本走席クリックで交代ピッカーを開く。
      const swapAttr = canSwap
        ? ` seat-swap" data-action="pick-swap" data-id="${t.id}" data-seat="${seatIdx}"`
        : `"`;
      const swapHint = canSwap ? `<div class="seat-swaphint">🔁 クリックで交代</div>` : "";
      return `<div class="seat seat-staff${swapAttr}>
        <div class="seat-name">🧑‍💼 ${st?.name ?? "店員"}${dealer}</div>
        <div class="seat-badge">本走</div>
        ${pts}
        ${swapHint}
      </div>`;
    }
    const c = state.customers.get(s.occupant.customerId);
    if (!c) return `<div class="seat seat-empty">空席</div>`;
    const call = s.call
      ? `<span class="call ${s.call === "LASTHAN" ? "call-last" : "call-mosh"}" title="${s.call === "LASTHAN" ? "ラスハン（この半荘で最後）" : "モシラス（続けるかも）"}">${s.call === "LASTHAN" ? "L" : "M"}</span>`
      : "";
    const low = c.bankroll <= c.startBankroll * 0.3 ? "seat-low" : "";
    // 入店時の希望（着席後も分かるように常時表示）。
    const prefBadge = prefBadgeHtml(c.pref);
    // 開始待ち（半荘前）は「開始待ち」時間を表示。我慢ゲージ比で色付け。
    let waitLine = "";
    if (waitingStart) {
      const pr = patienceRatio(c);
      waitLine = `<div class="seat-wait ${pr > 0.75 ? "seat-wait-urgent" : ""}">開始待ち ${Math.round(c.waitedMin)}/${c.patienceMin}分</div>`;
    }
    // 開始待ち（席埋め中）の客はクリックで別卓へ移動できる。対局中はクリック不可。
    const moveAttr = waitingStart
      ? ` seat-move" data-action="pick-move" data-id="${c.id}"`
      : `"`;
    const moveHint = waitingStart ? `<div class="seat-swaphint">↪️ クリックで移動</div>` : "";
    return `<div class="seat seat-cust ${low}${moveAttr}>
      <div class="seat-name">${c.emoji} ${c.name}${dealer} ${prefBadge}</div>
      <div class="seat-meta">${yen(c.bankroll)}</div>
      ${pts}
      ${waitLine}
      ${call}
      ${moveHint}
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
      const prefBadge = prefBadgeHtml(c.pref);
      const leaveIn = minsUntilLeave(state, c);
      const check = selected ? `<span class="w-check">✓</span> ` : "";
      const urgentBadge = pr > 0.75 ? `<span class="w-urgent-badge">急</span>` : "";
      chip.querySelector<HTMLElement>(".wbody")!.innerHTML = `
        <div class="w-top">${check}${c.emoji} <span class="w-name">${c.name}</span>${urgentBadge} ${prefBadge}</div>
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
      rankingView.builtForClosed = false;
      return;
    }
    el.result.className = "result-overlay show";
    // カードは閉店セッションで一度だけ構築（名前入力欄を再描画で潰さない）。
    if (!rankingView.builtForClosed) {
      buildResultCard(state);
      rankingView.builtForClosed = true;
      rankingView.loaded = false;
      rankingView.entries = [];
      rankingView.submittedId = null;
      void loadRanking();
    }
    updateRankingList();
  }

  function buildResultCard(state: GameState) {
    const k = kpis(state);
    const { rank, comment } = scoreRank(k.profit);
    // 1日の結果をプロフィールへ反映（この閉店で一度だけ）。通算加算・称号判定・ベスト更新。
    const day = buildDayResult(state);
    const applied = applyDayResult(profile, day);
    profile = applied.profile;
    newAchievements = applied.newAchievements;
    rankingView.isNewBest = applied.isNewBest && profile.gamesPlayed > 1; // 初日は「更新」表示しない
    saveProfile(profile);
    const savedName = profile.playerName;
    const bestLine = rankingView.isNewBest
      ? `<div class="result-best">🎉 自己ベスト更新！</div>`
      : "";
    el.result.innerHTML = `
      <div class="result-card">
        <div class="result-rank rank-${rank}">${rank}</div>
        <div class="result-title">本日の営業終了</div>
        <div class="result-comment">${comment}</div>
        ${bestLine}
        ${newAchievementsHtml()}
        <div class="result-grid">
          <div><span>利益</span><b>${yen(k.profit)}</b></div>
          <div><span>売上（場代）</span><b>${yen(k.revenue)}</b></div>
          <div><span>人件費</span><b class="bad">-${yen(k.wages)}</b></div>
          <div><span>接客した客数</span><b>${k.served}人</b></div>
          <div><span>打たれた半荘</span><b>${state.stats.hanchanPlayed}回</b></div>
          <div><span>満足して帰った</span><b>${state.stats.satisfied}人</b></div>
          <div><span>怒って帰った</span><b class="bad">${state.stats.rageQuits}人</b></div>
          <div><span>飛んで離席</span><b class="bad">${state.stats.busts}人</b></div>
          <div><span>平均待ち時間</span><b>${k.avgWait.toFixed(0)}分</b></div>
          <div><span>同時待ちピーク</span><b>${state.stats.peakWaiting}人</b></div>
          <div><span>最終評判</span><b>${Math.round(state.reputation)}</b></div>
        </div>
        ${careerPanelHtml()}
        <div class="rank-submit">
          <input id="rank-name" class="rank-name" maxlength="20" placeholder="店名・プレイヤー名" value="${escapeAttr(savedName)}" />
          <button data-action="submit-score" class="btn btn-blue rank-submit-btn">🏆 ランキングに登録</button>
        </div>
        <div id="rank-note" class="rank-note"></div>
        <div class="ranking-head">🏆 ランキング（利益順）</div>
        <div id="ranking-list" class="ranking-list"></div>
        <button data-action="restart" class="btn btn-green result-restart">🔁 もう一度開店する</button>
      </div>`;
  }

  /** 利益順TOPを非同期ロード（リモート失敗時はローカルキャッシュ）。 */
  async function loadRanking() {
    let entries: ScoreEntry[] = [];
    try {
      entries = await rankingStore.fetchTop(10);
    } catch {
      entries = [];
    }
    rankingView.entries = entries;
    rankingView.loaded = true;
    rerender();
  }

  /** スコア登録（名前を保存し、楽観的にハイライト）。 */
  async function onSubmitScore() {
    if (!lastState || !isClosed(lastState)) return;
    const input = el.result.querySelector<HTMLInputElement>("#rank-name");
    const name = input?.value ?? "";
    // 名前はプロフィールに保存（saveProfile が旧キーもミラーする）。
    profile = { ...profile, playerName: name.trim() };
    saveProfile(profile);
    const entry = buildScoreEntry(lastState, name);
    rankingView.submittedId = entry.id;
    el.result.querySelector<HTMLButtonElement>('[data-action="submit-score"]')?.setAttribute("disabled", "");
    try {
      rankingView.entries = await rankingStore.submit(entry);
    } catch {
      // ストア側でローカルフォールバック済み。最低限自分のエントリは見せる。
      if (!rankingView.entries.some((e) => e.id === entry.id)) {
        rankingView.entries = [entry, ...rankingView.entries];
      }
    }
    rankingView.loaded = true;
    rerender();
  }

  /** ランキングリスト領域だけを更新（カードは再構築しない）。 */
  function updateRankingList() {
    const listEl = el.result.querySelector<HTMLElement>("#ranking-list");
    if (!listEl) return;
    const submitBtn = el.result.querySelector<HTMLButtonElement>('[data-action="submit-score"]');
    if (rankingView.submittedId && submitBtn) submitBtn.setAttribute("disabled", "");

    if (!rankingView.loaded) {
      listEl.innerHTML = `<div class="ranking-empty">読み込み中…</div>`;
      return;
    }
    const entries = rankingView.entries.slice(0, 10);
    if (entries.length === 0) {
      listEl.innerHTML = `<div class="ranking-empty">まだ記録がありません。最初の1人になろう！</div>`;
    } else {
      // 競技順位（同点は同順位）。
      let displayRank = 0;
      let prevProfit: number | null = null;
      const rows = entries.map((e, i) => {
        if (prevProfit === null || e.profit !== prevProfit) displayRank = i + 1;
        prevProfit = e.profit;
        const me = e.id === rankingView.submittedId ? " ranking-me" : "";
        return `<div class="ranking-row${me}">
          <span class="ranking-pos">${displayRank}</span>
          <span class="ranking-badge rank-${e.rank}">${e.rank}</span>
          <span class="ranking-name">${escapeHtml(e.name)}</span>
          <span class="ranking-profit">${yen(e.profit)}</span>
        </div>`;
      });
      listEl.innerHTML = rows.join("");
    }

    // 登録後の自分の位置（パーセンタイル）を表示。
    const noteEl = el.result.querySelector<HTMLElement>("#rank-note");
    if (noteEl) {
      if (rankingView.submittedId) {
        const me = rankingView.entries.find((e) => e.id === rankingView.submittedId);
        if (me) {
          const pct = percentile(me, rankingView.entries);
          noteEl.innerHTML = `✅ 登録しました — あなたは上位 <b>${pct}%</b>（${rankingView.entries.length}人中）`;
        } else {
          noteEl.textContent = "✅ 登録しました";
        }
      } else {
        noteEl.textContent = "";
      }
    }
  }

  /** 今回新たに解放した称号のハイライト（無ければ空）。 */
  function newAchievementsHtml(): string {
    if (newAchievements.length === 0) return "";
    const items = newAchievements
      .map((a) => `<div class="ach-new-item"><span class="ach-emoji">${a.emoji}</span><span class="ach-text"><b>${a.title}</b><small>${a.desc}</small></span></div>`)
      .join("");
    return `<div class="ach-new"><div class="ach-new-head">🆕 称号を獲得！</div>${items}</div>`;
  }

  /** 通算（キャリア）パネル＋全称号の獲得状況。 */
  function careerPanelHtml(): string {
    const best = profile.bestProfit !== null ? yen(profile.bestProfit) : "—";
    const badges = ACHIEVEMENTS.map((a) => {
      const got = profile.unlockedAchievements.includes(a.id);
      return `<span class="ach-badge ${got ? "ach-got" : "ach-locked"}" title="${escapeAttr(a.title + "：" + a.desc)}">${got ? a.emoji : "🔒"}</span>`;
    }).join("");
    return `
      <div class="career-panel">
        <div class="career-head">📒 通算成績</div>
        <div class="career-grid">
          <div><span>営業日数</span><b>${profile.gamesPlayed}日</b></div>
          <div><span>自己ベスト</span><b>${best}${profile.bestRank ? `（${profile.bestRank}）` : ""}</b></div>
          <div><span>通算接客</span><b>${profile.careerServed}人</b></div>
          <div><span>無事故営業</span><b>${profile.cleanDays}日</b></div>
        </div>
        <div class="career-ach-head">称号 ${profile.unlockedAchievements.length}/${ACHIEVEMENTS.length}</div>
        <div class="career-ach">${badges}</div>
      </div>`;
  }

  return { render, reset, showSetup, hideSetup, showStart, showTutorial };
}

// ---- エスケープ（DOM側の小ユーティリティ）----
// 名前・ベスト等の永続は profile.ts（localStorage 抽象）に集約。
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// ---- 純ヘルパー ----

function statusLabel(t: Table): string {
  switch (t.progress.status) {
    case "WAITING_TO_START":
      return t.seats.every((s) => s.occupant.kind !== "EMPTY") ? "まもなく開始" : "席埋め中";
    case "EAST":
    case "SOUTH":
      return kyokuLabel(t); // 例: 東2局 / 南4局 1本場
    case "SETTLING":
      return "精算中";
    default:
      return "";
  }
}

/** 客の希望が卓レートと両立するか（ピッカー候補の絞り込み用）。 */
function prefAllowsRate(pref: Pref, rate: Rate): boolean {
  return pref === "ANY" || pref === rate;
}

/** 希望卓バッジ（待ち列・着席後で共用）。 */
function prefBadgeHtml(pref: Pref): string {
  if (pref === "BLUE") return `<span class="pref pref-blue">点5</span>`;
  if (pref === "GREEN") return `<span class="pref pref-green">点3</span>`;
  return `<span class="pref pref-any">どちらでも</span>`;
}

function repColor(r: number): string {
  if (r >= 66) return "var(--green)";
  if (r >= 33) return "var(--amber)";
  return "var(--red)";
}

void rateLabel; // 予約（将来のツールチップ用）

// ---- チュートリアル（オンボーディング）スライド ----
// 認知負荷を下げるため目的→ループ→点5/点3→交代/合卓 の順に分割（research: tutorial分散）。
const TUTORIAL_SLIDES: { emoji: string; title: string; body: string }[] = [
  {
    emoji: "🀄",
    title: "あなたは雀荘の店長",
    body: "17:00開店〜閉店まで卓を回し、<b>利益（場代の売上 − 店員の人件費）</b>を最大化するのが目的です。閉店時に成績がランキングに登録されます。時間は<b>「次のイベントへ」</b>を押すと次の判断ポイントまで自動で進みます（1プレイ ~5分）。",
  },
  {
    emoji: "🔄",
    title: "基本の流れ",
    body: "① 右の<b>待ち客</b>をタップで選ぶ（最大4人）→ ② <b>卓を立てる</b>（レートを選択）→ ③ 空席は<b>クリックして客を案内 or 店員（本走）</b>で埋める → ④「次のイベントへ」で対局を進める。本走は場代が入らないので、なるべく客で埋めましょう。",
  },
  {
    emoji: "🔵",
    title: "点5は怖いが稼げる",
    body: `<b>点5(ブルー)</b>＝場代${yen(CONFIG.gameFeeYen.BLUE)}/半荘で大きく稼げるが、手が大きく振れて<b>薄財布の客が飛ぶ</b>（評判が下がる）。<b>点3(グリーン)</b>＝場代${yen(CONFIG.gameFeeYen.GREEN)}/半荘で安全。コツは<b>厚財布の客を点5へ、薄い客は点3へ</b>。「どちらでも」の客の振り分けが腕の見せ所です。`,
  },
  {
    emoji: "🔁",
    title: "交代・合卓・レート",
    body: "東場のうち（または開始直前）は、<b>本走席をクリックして待ち客と交代</b>できます。半荘前の卓は<b>合卓</b>やレート変更も可能。各卓には「今できること」のヒントが出るので、迷ったら読んでください。さあ、開店です！",
  },
];

// ---- 骨格マークアップ ----
const SHELL = `
<div class="hud">
  <div class="hud-left">
    <div class="clock-wrap"><span class="clock-label">店内時刻</span><span id="clock" class="clock">12:00</span></div>
    <div class="day-track"><div id="day-bar" class="bar-fill day-bar"></div></div>
  </div>
  <div class="hud-mid">
    <div class="rev-wrap"><span class="rev-label">利益</span><span id="profit" class="rev">¥0</span></div>
    <div class="rev-sub">
      <span>売上 <b id="revenue">¥0</b></span>
      <span>人件費 <b id="wages" class="bad">-¥0</b></span>
    </div>
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
    <div id="advance-wrap" class="advance-wrap"></div>
  </div>
</div>

<div class="main">
  <section class="col col-tables">
    <h2 class="col-h">卓（フロア）</h2>
    <div id="staff" class="staff-card"></div>
    <div id="control" class="control"></div>
    <div id="tables" class="tables"></div>
  </section>
  <section class="col col-waiting">
    <h2 class="col-h">待ち客 <span id="waiting-count" class="badge">0</span></h2>
    <div id="waiting" class="waiting thin-scroll"></div>
  </section>
  <section class="col col-log">
    <input type="checkbox" id="log-toggle" class="log-toggle-cb" />
    <label for="log-toggle" class="col-h log-toggle">イベントログ <span class="log-caret">▾</span></label>
    <div id="log" class="log thin-scroll"></div>
  </section>
</div>

<div id="advance-bar" class="advance-bar"></div>

<div id="toast" class="toast"></div>
<div id="result" class="result-overlay"></div>
<div id="setup" class="setup-overlay"></div>
<div id="tutorial" class="tutorial-overlay"></div>
`;
