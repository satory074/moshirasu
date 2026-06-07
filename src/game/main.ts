// ===== 合成ルート: state → renderer → engine を配線 =====

import {
  combineAction,
  honsoAction,
  openTableAction,
  seatCustomerAction,
  setSpeedAction,
  swapAction,
  togglePauseAction,
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
        return toRes(seatCustomerAction(state, cmd.customerId, cmd.tableId));
      case "honso":
        return toRes(honsoAction(state, cmd.tableId));
      case "swap":
        return toRes(swapAction(state, cmd.customerId, cmd.tableId));
      case "combine":
        return toRes(combineAction(state, cmd.a, cmd.b));
      case "setSpeed":
        setSpeedAction(state, cmd.speed);
        return { ok: true };
      case "togglePause":
        togglePauseAction(state);
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

  function startNew(seed: number) {
    state = createInitialState(seed);
    renderer.reset();
    engine = createEngine(state, renderer.render);
    engine.start();
    renderer.render(state);
  }

  function restart() {
    engine?.stop();
    startNew(newSeed());
  }

  // キーボード: スペースで一時停止トグル
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      dispatch({ type: "togglePause" });
      renderer.render(state);
    }
  });

  startNew(readSeed());
}

function newSeed(): number {
  return Math.floor(Date.now() % 2147483647) || 67890;
}

// DOM 準備後に起動
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
