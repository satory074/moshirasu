// ===== seed 付き擬似乱数 =====
// 全乱数を1インスタンスに集約し、?seed= でリプレイ可能にする。

export interface Rng {
  /** [0,1) の一様乱数。 */
  next(): number;
  /** [min,max) の一様乱数。 */
  range(min: number, max: number): number;
  /** [min,max] の整数。 */
  int(min: number, max: number): number;
  /** 確率 p で true。 */
  chance(p: number): boolean;
  /** 配列から1つ選ぶ。 */
  pick<T>(arr: readonly T[]): T;
  /** 重み付き選択。entries = [[値, 重み], ...]。 */
  weighted<T>(entries: readonly [T, number][]): T;
  /** 正規分布（平均mean・標準偏差sd）。 */
  gaussian(mean: number, sd: number): number;
}

/** mulberry32: 小さく高速な決定的 PRNG。 */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    weighted: (entries) => {
      let total = 0;
      for (const [, w] of entries) total += w;
      let r = next() * total;
      for (const [v, w] of entries) {
        r -= w;
        if (r < 0) return v;
      }
      return entries[entries.length - 1][0];
    },
    gaussian: (mean, sd) => {
      // Box-Muller
      let u = 0;
      let v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
      return mean + z * sd;
    },
  };
  return rng;
}
