// ===== リアルタイム tick ループ（rAF + 固定タイムステップ蓄積器）=====

import { CONFIG } from "./config";
import { maybeSpawnArrival, tickWaiting } from "./customers";
import { addLog } from "./state";
import { advanceHanchan } from "./tables";
import type { GameState } from "./types";

export interface Engine {
  start(): void;
  stop(): void;
}

/**
 * エンジンを生成。onFrame は毎フレーム（描画用）呼ばれる。
 * 時間進行は state.speed に従い、0 のときは描画のみ。
 */
export function createEngine(state: GameState, onFrame: (state: GameState) => void): Engine {
  let rafId = 0;
  let running = false;
  let last = 0;
  let acc = 0;

  const loop = (now: number) => {
    if (!running) return;
    const dt = last === 0 ? 0 : now - last;
    last = now;

    if (state.speed !== 0 && state.phase !== "CLOSED") {
      acc += dt * state.speed;
      let steps = 0;
      while (acc >= CONFIG.tickMs && steps < CONFIG.maxStepsPerFrame) {
        tick(state);
        acc -= CONFIG.tickMs;
        steps++;
        if ((state.phase as string) === "CLOSED") break;
      }
    }

    onFrame(state);

    if (state.phase === "CLOSED") {
      running = false;
      return;
    }
    rafId = requestAnimationFrame(loop);
  };

  return {
    start() {
      if (running) return;
      running = true;
      last = 0;
      acc = 0;
      rafId = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
    },
  };
}

/** 1tick（ゲーム内 minutesPerTick 分）進める。順序は決定的。 */
export function tick(state: GameState): void {
  const dt = CONFIG.minutesPerTick;
  // ① 時計
  state.clockMin += dt;

  // ② 閉店判定
  if (state.phase === "OPEN" && state.clockMin >= CONFIG.closeMin) {
    state.phase = "CLOSING";
    addLog(state, "INFO", "🔔 ラストオーダー。新規来店は締め切り、進行中の半荘は続行します");
  }

  // ③ 来店抽選（OPEN のみ）
  maybeSpawnArrival(state);

  // ④ 待ち更新＋怒り/時間切れ離席
  tickWaiting(state, dt);

  // ⑤ 各卓の半荘進行
  // 配列が teardown で変化しうるのでコピーを回す。
  for (const table of [...state.tables]) {
    advanceHanchan(state, table, dt);
  }

  // ⑥ 閉店の最終判定: CLOSING で進行中の半荘が無い、または強制閉店時刻
  if (state.phase === "CLOSING") {
    const anyPlaying = state.tables.some(
      (t) => t.progress.status === "EAST" || t.progress.status === "SOUTH" || t.progress.status === "SETTLING",
    );
    if (!anyPlaying || state.clockMin >= CONFIG.hardCloseMin) {
      state.phase = "CLOSED";
      addLog(state, "INFO", "🏁 閉店しました。本日の営業終了。");
    }
  }
}
