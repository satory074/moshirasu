// ===== ランキング（スコア永続化）=====
// フレームワーク非依存。localStorage / fetch は存在ガードし、node/tsx でも壊さない。
// 抽象: RankingStore（async）。実装: Local（localStorage/メモリ）と Supabase（fetch・SDK不使用）。
// createRankingStore() が唯一の差し替え点 — Supabase の env があればリモート＋ローカルミラー、
// 無ければローカルのみ（graceful degradation）。
//
// 注意: ここで使う Date.now()/new Date() はエンジン外の永続メタデータ用であり、
// state.rng による決定論（リプレイ）には影響しない。モジュールロード時には呼ばない。

import { scoreRank } from "./config";
import { kpis } from "./selectors";
import type { GameState } from "./types";

const STORAGE_KEY = "moshirasu.ranking.v1";
const CAP = 50; // 保持する最大件数（肥大防止）

export interface ScoreEntry {
  id: string;
  name: string;
  profit: number;
  rank: string;
  staffCount: number;
  served: number;
  hanchan: number;
  seed: number;
  atIso: string;
}

export interface RankingStore {
  /** 1件登録し、登録後の最新TOP（ソート済み）を返す。 */
  submit(entry: ScoreEntry): Promise<ScoreEntry[]>;
  /** 利益順TOPを最大 limit 件返す。 */
  fetchTop(limit: number): Promise<ScoreEntry[]>;
}

// ---- ソート / タイブレーク ----
// 利益降順 → 接客数降順 → 登録が早い順（atIso 昇順）。
function compareEntries(a: ScoreEntry, b: ScoreEntry): number {
  if (b.profit !== a.profit) return b.profit - a.profit;
  if (b.served !== a.served) return b.served - a.served;
  return a.atIso < b.atIso ? -1 : a.atIso > b.atIso ? 1 : 0;
}

function sortAndCap(entries: ScoreEntry[]): ScoreEntry[] {
  return [...entries].sort(compareEntries).slice(0, CAP);
}

/** 自分のエントリが全体で上位何%か（1..100、小さいほど上位）。 */
export function percentile(entry: ScoreEntry, all: ScoreEntry[]): number {
  if (all.length === 0) return 100;
  const better = all.filter((e) => e.profit > entry.profit).length;
  const pos = better + 1;
  return Math.max(1, Math.round((pos / all.length) * 100));
}

/** 一意な ID を採番（crypto.randomUUID 優先、無ければ時刻＋乱数）。エンジン外なので Date/random 可。 */
function newScoreId(seed: number): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    /* fallthrough */
  }
  return `${Date.now()}-${seed}-${Math.floor(Math.random() * 1e9)}`;
}

/** 現在の GameState とプレイヤー名から登録用エントリを作る（id/atIso は採番）。 */
export function buildScoreEntry(state: GameState, name: string): ScoreEntry {
  const k = kpis(state);
  const { rank } = scoreRank(k.profit);
  const trimmed = name.trim().slice(0, 20) || "名無しの店長";
  return {
    id: newScoreId(state.seed),
    name: trimmed,
    profit: Math.round(k.profit),
    rank,
    staffCount: state.staff.length,
    served: state.stats.served,
    hanchan: state.stats.hanchanPlayed,
    seed: state.seed,
    atIso: new Date().toISOString(),
  };
}

// ---- 低レベルストレージ（DI 可能）----

export interface ScoreStorage {
  load(): ScoreEntry[];
  save(entries: ScoreEntry[]): void;
}

/** localStorage バックエンド（quota/破損で落ちない）。利用不可なら null。 */
function browserStorage(key: string): ScoreStorage | null {
  let ls: Storage;
  try {
    if (typeof localStorage === "undefined") return null;
    ls = localStorage;
    // 実書き込みテスト（プライベートブラウズ等で例外になることがある）。
    const probe = "__moshirasu_probe__";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
  } catch {
    return null;
  }
  return {
    load() {
      try {
        const raw = ls.getItem(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as ScoreEntry[]) : [];
      } catch {
        return []; // 破損は空扱い
      }
    },
    save(entries) {
      try {
        ls.setItem(key, JSON.stringify(entries));
      } catch {
        /* QuotaExceededError 等は握りつぶす（保存できなくてもクラッシュさせない） */
      }
    },
  };
}

/** メモリバックエンド（node/tsx・localStorage 不可時のフォールバック）。 */
function memoryStorage(): ScoreStorage {
  let mem: ScoreEntry[] = [];
  return {
    load: () => [...mem],
    save: (entries) => {
      mem = [...entries];
    },
  };
}

function defaultStorage(): ScoreStorage {
  return browserStorage(STORAGE_KEY) ?? memoryStorage();
}

// ---- ローカル実装 ----

export class LocalRankingStore implements RankingStore {
  constructor(private readonly storage: ScoreStorage = defaultStorage()) {}

  async submit(entry: ScoreEntry): Promise<ScoreEntry[]> {
    const all = sortAndCap([...this.storage.load(), entry]);
    this.storage.save(all);
    return all;
  }

  async fetchTop(limit: number): Promise<ScoreEntry[]> {
    return sortAndCap(this.storage.load()).slice(0, limit);
  }

  /** リモート成功分をローカルにミラー（重複は id でマージ）。 */
  mirror(entries: ScoreEntry[]): void {
    const byId = new Map<string, ScoreEntry>();
    for (const e of [...this.storage.load(), ...entries]) byId.set(e.id, e);
    this.storage.save(sortAndCap([...byId.values()]));
  }
}

// ---- Supabase 実装（fetch のみ・SDK 不使用）----

interface SupabaseConfig {
  url: string;
  anonKey: string;
}

// ScoreEntry(camelCase) ↔ DB 行(snake_case) の相互変換。
interface ScoreRow {
  id: string;
  name: string;
  profit: number;
  rank: string;
  staff_count: number;
  served: number;
  hanchan: number;
  seed: number;
  at_iso: string;
}

function toRow(e: ScoreEntry): ScoreRow {
  return {
    id: e.id,
    name: e.name,
    profit: e.profit,
    rank: e.rank,
    staff_count: e.staffCount,
    served: e.served,
    hanchan: e.hanchan,
    seed: e.seed,
    at_iso: e.atIso,
  };
}

function fromRow(r: ScoreRow): ScoreEntry {
  return {
    id: r.id,
    name: r.name,
    profit: r.profit,
    rank: r.rank,
    staffCount: r.staff_count,
    served: r.served,
    hanchan: r.hanchan,
    seed: r.seed,
    atIso: r.at_iso,
  };
}

export class SupabaseRankingStore implements RankingStore {
  private readonly endpoint: string;
  constructor(
    private readonly cfg: SupabaseConfig,
    private readonly local: LocalRankingStore = new LocalRankingStore(),
  ) {
    this.endpoint = `${cfg.url.replace(/\/$/, "")}/rest/v1/scores`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.cfg.anonKey,
      Authorization: `Bearer ${this.cfg.anonKey}`,
      ...extra,
    };
  }

  async submit(entry: ScoreEntry): Promise<ScoreEntry[]> {
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json", Prefer: "return=minimal" }),
        body: JSON.stringify(toRow(entry)),
      });
      if (!res.ok) throw new Error(`insert failed: ${res.status}`);
      // ローカルにもミラーしてオフライン表示に使う。
      this.local.mirror([entry]);
      return this.fetchTop(10);
    } catch {
      // リモート不通: ローカルに保存して継続（graceful degradation）。
      return this.local.submit(entry);
    }
  }

  async fetchTop(limit: number): Promise<ScoreEntry[]> {
    try {
      const url = `${this.endpoint}?select=*&order=profit.desc,served.desc,at_iso.asc&limit=${limit}`;
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) throw new Error(`select failed: ${res.status}`);
      const rows = (await res.json()) as ScoreRow[];
      const entries = rows.map(fromRow);
      this.local.mirror(entries);
      return entries;
    } catch {
      return this.local.fetchTop(limit); // ローカルキャッシュにフォールバック
    }
  }
}

// ---- ファクトリ（唯一の差し替え点）----

function readEnv(name: string): string | undefined {
  try {
    // Astro/Vite はビルド時に import.meta.env へ静的展開。node/tsx では undefined。
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const v = env?.[name];
    return v && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 設定に応じて RankingStore を生成。
 * - PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY が揃えば共有（Supabase＋ローカルミラー）
 * - 無ければローカルのみ（GitHub Pages 完結・ビルド/テスト/dev も動く）
 */
export function createRankingStore(): RankingStore {
  const url = readEnv("PUBLIC_SUPABASE_URL");
  const anonKey = readEnv("PUBLIC_SUPABASE_ANON_KEY");
  if (url && anonKey) {
    return new SupabaseRankingStore({ url, anonKey });
  }
  return new LocalRankingStore();
}
