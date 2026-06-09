// ===== 合成ルート: state → renderer → engine を配線 =====

import {
  changeRateAction,
  combineAction,
  honsoAction,
  honsoAllAction,
  moveCustomerAction,
  openTableAction,
  seatCustomerAction,
  setSpeedAction,
  swapAction,
} from "./actions";
import { createEngine, type Engine } from "./engine";
import { createRenderer, type Command } from "./render";
import { createInitialState } from "./state";
import type { GameState, Result } from "./types";

function readSeed(): number {
  const params = new URLSearchParams(window.location.search);
  const s = params.get("seed");
  if (s && /^\d+$/.test(s)) return Number(s);
  // 日付ベースの擬似シード（時刻はゲーム内では使わないので起動時の1回のみ）。
  return Math.floor(Date.now() % 2147483647) || 12345;
}

export function boot(): void {
  const root = document.getElementById("app");
  if (!root) throw new Error("#app not found");

  let state: GameState;
  let engine: Engine;

  const renderer = createRenderer(root, dispatch);

  function dispatch(cmd: Command): { ok: boolean; reason?: string } {
    switch (cmd.type) {
      case "openTable":
        return toRes(openTableAction(state, cmd.rate, cmd.customerIds));
      case "seat":
        return toRes(seatCustomerAction(state, cmd.customerId, cmd.tableId, cmd.seatIdx));
      case "honso":
        return toRes(honsoAction(state, cmd.tableId, cmd.seatIdx, cmd.staffId));
      case "honsoAll":
        return toRes(honsoAllAction(state));
      case "swap":
        return toRes(swapAction(state, cmd.customerId, cmd.tableId, cmd.seatIdx));
      case "move":
        return toRes(moveCustomerAction(state, cmd.customerId, cmd.tableId, cmd.seatIdx));
      case "combine":
        return toRes(combineAction(state, cmd.a, cmd.b));
      case "changeRate":
        return toRes(changeRateAction(state, cmd.tableId));
      case "startGame":
        startGame(cmd.staffCount);
        return { ok: true };
      case "advance":
        engine.advance();
        return { ok: true };
      case "setSpeed":
        return toRes(setSpeedAction(state, cmd.mult));
      case "pause":
        engine.stop();
        renderer.render(state); // 進行停止をボタン表示に反映
        return { ok: true };
      case "restart":
        restart();
        return { ok: true };
      default:
        return { ok: true };
    }
  }

  function toRes(r: Result): { ok: boolean; reason?: string } {
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }

  function startNew(seed: number, staffCount: number) {
    state = createInitialState(seed, staffCount);
    renderer.reset();
    engine = createEngine(state, renderer.render);
    renderer.render(state); // 自動進行はしない。最初の描画のみ。
  }

  // 開店前設定で店員数を決めて営業開始。
  function startGame(staffCount: number) {
    renderer.hideSetup();
    startNew(readSeed(), staffCount);
  }

  function restart() {
    engine?.stop();
    renderer.reset();
    renderer.showSetup(); // 再戦時も店員数を選び直す（「最初だけ決定」を一貫）。
  }

  // キーボード: スペースで「次のイベントへ」（設定画面表示中は無効）
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      if (state) dispatch({ type: "advance" });
    }
  });

  // 起動時は即開始せず、初回はチュートリアル→以降は開店前設定を表示する。
  renderer.showStart();
}

// DOM 準備後に起動
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
