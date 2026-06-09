// ===== プレイヤープロフィール（キャリア記録＋称号・永続メタ進行）=====
// 単一難易度のまま「通算記録」と「称号(アンロック)」で再訪動機を作る層。
// フレームワーク非依存・DOMフリー。KV ストレージを DI でき、node/tsx でも壊さない
// （ranking.ts の ScoreStorage と同じ思想）。
//
// 注意: ここで読む localStorage はエンジン外の永続データであり、state.rng の決定論
// （?seed= リプレイ）には一切影響しない。

import { scoreRank } from "./config";
import { kpis } from "./selectors";
import type { GameState } from "./types";

const PROFILE_KEY = "moshirasu.profile.v1";
// 旧キー（プロフィール導入前）。後方互換のため移行・ミラーする。
const OLD_NAME_KEY = "moshirasu.playerName";
const OLD_BEST_KEY = "moshirasu.bestProfit";

/** プレイヤーの通算プロフィール（このブラウザに永続）。 */
export interface PlayerProfile {
  v: 1;
  /** チュートリアルを一度でも完了/スキップしたか。 */
  onboarded: boolean;
  playerName: string;
  gamesPlayed: number;
  /** 自己ベスト利益（未記録なら null）。 */
  bestProfit: number | null;
  /** 自己ベストの評価レター（未記録なら ""）。 */
  bestRank: string;
  // ---- 通算（キャリア）集計 ----
  careerProfit: number;
  careerServed: number;
  careerHanchan: number;
  careerBusts: number;
  careerSatisfied: number;
  /** 飛び0で閉店した日数。 */
  cleanDays: number;
  /** 解放済みの称号ID。 */
  unlockedAchievements: string[];
}

/** 1日（1回の閉店）の結果。applyDayResult の入力。 */
export interface DayResult {
  profit: number;
  rank: string;
  served: number;
  hanchan: number;
  blueHanchan: number;
  busts: number;
  satisfied: number;
  rageQuits: number;
  reputation: number;
}

/** 称号の定義。check は (その日の結果, 加算後のキャリア) を見る述語。 */
export interface Achievement {
  id: string;
  title: string;
  emoji: string;
  desc: string;
  check: (day: DayResult, career: PlayerProfile) => boolean;
}

// 称号リスト。数値だけでなく「質の違う」達成条件を混ぜる
// （単発の利益・S評価・無事故・点5比率・接客数・通算日数・通算利益）。
export const ACHIEVEMENTS: Achievement[] = [
  { id: "first-day", title: "初営業", emoji: "🎉", desc: "初めて閉店まで店を切り盛りした", check: (_d, c) => c.gamesPlayed >= 1 },
  { id: "profit-50k", title: "黒字の達人", emoji: "💰", desc: "1日で利益¥50,000を達成", check: (d) => d.profit >= 50000 },
  { id: "profit-80k", title: "大勝負師", emoji: "🀄", desc: "1日で利益¥80,000を達成", check: (d) => d.profit >= 80000 },
  { id: "rank-s", title: "伝説の店長", emoji: "👑", desc: "S評価で閉店した", check: (d) => d.rank === "S" },
  { id: "clean-day", title: "無事故営業", emoji: "🛡️", desc: "飛び0かつB評価以上で閉店した", check: (d) => d.busts === 0 && d.profit >= 34000 },
  { id: "blue-master", title: "点5の鬼", emoji: "🔥", desc: "点5半荘7割以上＆A評価以上で閉店", check: (d) => d.hanchan > 0 && d.blueHanchan / d.hanchan >= 0.7 && d.profit >= 52000 },
  { id: "busy-night", title: "大盛況", emoji: "🎊", desc: "1日で40人以上を接客した", check: (d) => d.served >= 40 },
  { id: "regular-shop", title: "常連の店", emoji: "🏮", desc: "通算10日営業した", check: (_d, c) => c.gamesPlayed >= 10 },
  { id: "tycoon", title: "雀荘王", emoji: "🏆", desc: "通算利益¥500,000を突破", check: (_d, c) => c.careerProfit >= 500000 },
];

const RANK_ORDER: Record<string, number> = { D: 1, C: 2, B: 3, A: 4, S: 5 };

/** 評価レターの上位を返す（記録なし "" は最下扱い）。 */
export function betterRank(a: string, b: string): string {
  return (RANK_ORDER[a] ?? 0) >= (RANK_ORDER[b] ?? 0) ? a : b;
}

/** 初期プロフィール。 */
export function defaultProfile(): PlayerProfile {
  return {
    v: 1,
    onboarded: false,
    playerName: "",
    gamesPlayed: 0,
    bestProfit: null,
    bestRank: "",
    careerProfit: 0,
    careerServed: 0,
    careerHanchan: 0,
    careerBusts: 0,
    careerSatisfied: 0,
    cleanDays: 0,
    unlockedAchievements: [],
  };
}

// ---- KV ストレージ（DI 可能・localStorage/メモリ）----

export interface KV {
  get(key: string): string | null;
  set(key: string, val: string): void;
}

function browserKV(): KV | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const probe = "__moshirasu_profile_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
  } catch {
    return null;
  }
  return {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, val) {
      try {
        localStorage.setItem(key, val);
      } catch {
        /* quota 等は握りつぶす */
      }
    },
  };
}

function memoryKV(): KV {
  const mem = new Map<string, string>();
  return {
    get: (k) => (mem.has(k) ? mem.get(k)! : null),
    set: (k, v) => void mem.set(k, v),
  };
}

function defaultKV(): KV {
  return browserKV() ?? memoryKV();
}

/** プロフィールを読み込む（無ければ旧キーから移行・最終的に既定値で穴埋め）。 */
export function loadProfile(kv: KV = defaultKV()): PlayerProfile {
  const raw = kv.get(PROFILE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PlayerProfile>;
      // 既定値で前方互換に穴埋め（将来フィールド追加に強い）。
      return { ...defaultProfile(), ...parsed, v: 1 };
    } catch {
      /* 破損は移行/既定へフォールスルー */
    }
  }
  // 旧キーからの移行（プロフィール導入前のユーザのベスト記録/名前を失わない）。
  const p = defaultProfile();
  const oldName = kv.get(OLD_NAME_KEY);
  if (oldName) p.playerName = oldName;
  const oldBest = kv.get(OLD_BEST_KEY);
  if (oldBest !== null && oldBest !== "") {
    const n = Number(oldBest);
    if (Number.isFinite(n)) p.bestProfit = n;
  }
  return p;
}

/** プロフィールを保存（旧キーもミラーして後方互換を保つ）。 */
export function saveProfile(profile: PlayerProfile, kv: KV = defaultKV()): void {
  kv.set(PROFILE_KEY, JSON.stringify(profile));
  // 旧キー互換: 名前・ベストを直接読む既存コードがあっても壊れないようにミラー。
  kv.set(OLD_NAME_KEY, profile.playerName);
  if (profile.bestProfit !== null) kv.set(OLD_BEST_KEY, String(profile.bestProfit));
}

/** GameState から1日の結果を作る。 */
export function buildDayResult(state: GameState): DayResult {
  const k = kpis(state);
  const profit = Math.round(k.profit);
  return {
    profit,
    rank: scoreRank(profit).rank,
    served: state.stats.served,
    hanchan: state.stats.hanchanPlayed,
    blueHanchan: state.stats.blueHanchanPlayed,
    busts: state.stats.busts,
    satisfied: state.stats.satisfied,
    rageQuits: state.stats.rageQuits,
    reputation: Math.round(state.reputation),
  };
}

/**
 * 1日の結果をプロフィールに反映する純関数。
 * 通算を加算し、新たに条件を満たした称号を返す（既存の解放済みは除外）。
 * isNewBest は加算前のベストと比較した「自己ベスト更新か」。
 */
export function applyDayResult(
  profile: PlayerProfile,
  day: DayResult,
): { profile: PlayerProfile; newAchievements: Achievement[]; isNewBest: boolean } {
  const isNewBest = profile.bestProfit === null || day.profit > profile.bestProfit;
  const next: PlayerProfile = {
    ...profile,
    gamesPlayed: profile.gamesPlayed + 1,
    bestProfit: profile.bestProfit === null ? day.profit : Math.max(profile.bestProfit, day.profit),
    bestRank: betterRank(profile.bestRank, day.rank),
    careerProfit: profile.careerProfit + day.profit,
    careerServed: profile.careerServed + day.served,
    careerHanchan: profile.careerHanchan + day.hanchan,
    careerBusts: profile.careerBusts + day.busts,
    careerSatisfied: profile.careerSatisfied + day.satisfied,
    cleanDays: profile.cleanDays + (day.busts === 0 ? 1 : 0),
    unlockedAchievements: [...profile.unlockedAchievements],
  };

  const unlocked = new Set(next.unlockedAchievements);
  const newAchievements: Achievement[] = [];
  for (const a of ACHIEVEMENTS) {
    if (unlocked.has(a.id)) continue;
    if (a.check(day, next)) {
      unlocked.add(a.id);
      newAchievements.push(a);
    }
  }
  next.unlockedAchievements = [...unlocked];
  return { profile: next, newAchievements, isNewBest };
}
