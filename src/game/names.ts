// ===== 客の名前・絵文字プール（純データ）=====

import type { Rng } from "./rng";

const SURNAMES = [
  "佐藤", "鈴木", "高橋", "田中", "渡辺", "伊藤", "山本", "中村", "小林", "加藤",
  "吉田", "山田", "佐々木", "山口", "松本", "井上", "木村", "林", "斎藤", "清水",
  "山崎", "森", "池田", "橋本", "阿部", "石川", "前田", "藤田", "後藤", "岡田",
];

// 雀荘っぽいニックネーム（常連の通り名）。
const NICKNAMES = [
  "ロン田", "ツモ蔵", "リーチ松", "ドラ汰", "メンタン", "親っぱ", "国士", "ハネ満",
  "倍満爺", "赤き", "ヤミテン", "サンマ", "ベタオリ", "差し込み", "天和", "イーペー",
];

const EMOJIS = ["🀄", "😎", "🧓", "🤓", "🧑", "👨", "👩", "🕴️", "👨‍💼", "🧔", "👴", "👵", "🐯", "🐲", "🦊", "🐼"];

/** ランダムな客の表示名と絵文字を生成。 */
export function genNameEmoji(rng: Rng): { name: string; emoji: string } {
  const useNick = rng.chance(0.35);
  const name = useNick ? rng.pick(NICKNAMES) : `${rng.pick(SURNAMES)}さん`;
  return { name, emoji: rng.pick(EMOJIS) };
}

const STAFF_NAMES = ["店長", "メンバー A", "メンバー B", "メンバー C"];

/** 店員名（順番に割り当て）。 */
export function staffName(idx: number): string {
  return STAFF_NAMES[idx] ?? `メンバー ${idx}`;
}
