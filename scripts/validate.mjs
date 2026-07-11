#!/usr/bin/env node
/**
 * タビゴ教材データ検証スクリプト
 * 使い方: node scripts/validate.mjs train.html
 * ERROR が1件でもあれば exit 1(公開・コミット禁止)。WARN は判断材料。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const file = process.argv[2] || "train.html";
const src = readFileSync(file, "utf-8");
const errors = [];
const warns = [];
let banks = {};
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

/* --- 不可侵チェック(文字列レベル) --- */
if (!src.includes('KEY = "tabigo-train-v1"')) err("localStorageキー tabigo-train-v1 が見つからない(変更禁止)");
if (!/ivl:0,\s*due:null,\s*ease:2\.0,\s*reps:0,\s*lap:0,\s*hist:\[\],\s*stage:0/.test(src))
  err("SRS状態フィールド(ivl/due/ease/reps/lap/hist/stage)の初期化形が変わっている(変更禁止)");

/* --- コンテンツバンク抽出 --- */
const mScript = src.match(/<script>([\s\S]*?)<\/script>/);
if (!mScript) { err("<script>ブロックが見つからない"); report(); }
const script = mScript[1];
const start = script.indexOf("コンテンツバンク");
const end = script.indexOf("状態管理");
if (start < 0 || end < 0 || end <= start) {
  err("セクションマーカー(コンテンツバンク/状態管理)が見つからない(削除・改名禁止)");
  report();
}
const bankSrc = script.slice(script.indexOf("*/", start) + 2, script.lastIndexOf("/*", end));

try {
  const ctx = vm.createContext({});
  banks = vm.runInContext(
    bankSrc + "\n;({SENT,CHUNK,LISTEN,SHADOW,STORY,TIP,WEEK_THEME,MAP_STOPS});",
    ctx, { timeout: 5000 }
  );
} catch (e) {
  err("コンテンツバンクの評価に失敗: " + e.message);
  report();
}
const { SENT, CHUNK, LISTEN, SHADOW, STORY, TIP, WEEK_THEME, MAP_STOPS } = banks;
for (const [name, v] of Object.entries({ SENT, CHUNK, LISTEN, SHADOW, STORY, TIP })) {
  if (!Array.isArray(v) || v.length === 0) err(`${name} が存在しないか空`);
}
if (errors.length) report();

/* --- 共通: ID検査 --- */
function checkIds(arr, name, re) {
  const seen = new Set();
  arr.forEach((x) => {
    if (!x.id || !re.test(x.id)) err(`${name}: ID形式が不正 "${x.id}"`);
    if (seen.has(x.id)) err(`${name}: ID重複 "${x.id}"`);
    seen.add(x.id);
  });
}
checkIds(SENT, "SENT", /^s\d{2,3}$/);
checkIds(CHUNK, "CHUNK", /^c\d{2,3}$/);
checkIds(LISTEN, "LISTEN", /^l\d{2,3}$/);
checkIds(SHADOW, "SHADOW", /^sh\d+$/);
checkIds(STORY, "STORY", /^st\d+$/);
checkIds(TIP, "TIP", /^t\d+$/);

const asciiOk = (s) => /^[\x20-\x7E〜～'’]+$/.test(s); // ASCII + 〜(2種) + '
const wordCount = (s) => s.trim().split(/\s+/).length;

/* --- SENT --- */
const LV_MAXWORDS = { 1: 6, 2: 9, 3: 11, 4: 14 };
const enSeen = new Set();
SENT.forEach((s) => {
  const tag = `SENT ${s.id}`;
  if (!s.ja || !s.en) err(`${tag}: ja/en が空`);
  if (![1, 2, 3, 4].includes(s.lv)) err(`${tag}: lv は1〜4 (現在 ${s.lv})`);
  if (!(Number.isInteger(s.wk) && s.wk >= 1 && s.wk <= 12)) err(`${tag}: wk は1〜12 (現在 ${s.wk})`);
  if (typeof s.alt !== "string" || typeof s.q !== "string") err(`${tag}: alt/q は文字列(空文字可)で必須`);
  if (s.en && !asciiOk(s.en)) err(`${tag}: en に許可外の文字 "${s.en}"`);
  if (s.en) {
    const key = s.en.toLowerCase().replace(/[^a-z ]/g, "");
    if (enSeen.has(key)) err(`${tag}: en が既存文と重複 "${s.en}"`);
    enSeen.add(key);
    if (wordCount(s.en) > (LV_MAXWORDS[s.lv] || 14) + 2) warn(`${tag}: lv${s.lv}にしては長い(${wordCount(s.en)}語): "${s.en}"`);
  }
  if (s.en && /\b(I am|do not|cannot|May I)\b/.test(s.en)) warn(`${tag}: 教科書調の可能性 "${s.en}"(短縮形/Can I を推奨)`);
});

/* --- 週ごとの構成 --- */
const maxWk = Math.max(...SENT.map((s) => s.wk));
for (let w = 1; w <= maxWk; w++) {
  const ws = SENT.filter((s) => s.wk === w);
  if (ws.length < 8) err(`第${w}週: SENTが${ws.length}文(最低8文)`);
  for (const lv of [1, 2, 3, 4]) {
    if (!ws.some((s) => s.lv === lv)) err(`第${w}週: lv${lv} の文が1つもない`);
  }
  if (!(WEEK_THEME && WEEK_THEME[w])) err(`第${w}週: WEEK_THEME[${w}] が未定義`);
}

/* --- CHUNK --- */
CHUNK.forEach((c) => {
  const tag = `CHUNK ${c.id}`;
  if (!["phr", "word", "talk"].includes(c.kind)) err(`${tag}: kind不正 "${c.kind}"`);
  if (![0, 1].includes(c.pri)) err(`${tag}: pri は 0 か 1`);
  for (const f of ["en", "ja", "ex", "exJa"]) if (!c[f]) err(`${tag}: ${f} が空`);
  if (c.en && !asciiOk(c.en)) err(`${tag}: en に許可外の文字 "${c.en}"`);
  if (c.ex && !asciiOk(c.ex)) err(`${tag}: ex に許可外の文字 "${c.ex}"`);
});

/* --- LISTEN --- */
LISTEN.forEach((l) => {
  const tag = `LISTEN ${l.id}`;
  if (!l.text || !l.q) err(`${tag}: text/q が空`);
  if (!Array.isArray(l.ch) || l.ch.length !== 3) err(`${tag}: 選択肢は3つ`);
  else {
    if (new Set(l.ch).size !== 3) err(`${tag}: 選択肢が重複`);
    if (!(Number.isInteger(l.a) && l.a >= 0 && l.a <= 2)) err(`${tag}: a は0〜2`);
  }
  if (l.text && !asciiOk(l.text)) err(`${tag}: text に許可外の文字`);
  if (l.text && wordCount(l.text) > 20) warn(`${tag}: 音声が長い(${wordCount(l.text)}語)`);
});

/* --- SHADOW --- */
SHADOW.forEach((s) => {
  const tag = `SHADOW ${s.id}`;
  if (!s.title) err(`${tag}: title が空`);
  if (!Array.isArray(s.lines) || s.lines.length !== 4) err(`${tag}: lines は4行`);
  else s.lines.forEach((L, i) => {
    if (!L.en || !L.ja) err(`${tag}: ${i + 1}行目の en/ja が空`);
    if (L.en && !asciiOk(L.en)) err(`${tag}: ${i + 1}行目に許可外の文字`);
  });
});

/* --- STORY / TIP --- */
STORY.forEach((s) => {
  const tag = `STORY ${s.id}`;
  for (const f of ["title", "text", "ja"]) if (!s[f]) err(`${tag}: ${f} が空`);
  const wc = s.text ? wordCount(s.text) : 0;
  if (wc && (wc < 40 || wc > 100)) warn(`${tag}: 本文${wc}語(目安50〜80語)`);
});
TIP.forEach((t) => { if (!t.en || !t.ja) err(`TIP ${t.id}: en/ja が空`); });

/* --- MAP --- */
if (!Array.isArray(MAP_STOPS) || MAP_STOPS.length < 12) err("MAP_STOPS は12停留地以上");

report();

function report() {
  console.log("=== タビゴ教材検証 ===");
  console.log(`対象: ${file}`);
  if (banks && banks.SENT) {
    console.log(`収録: 文${banks.SENT.length} / チャンク${banks.CHUNK?.length} / リスニング${banks.LISTEN?.length} / シャドー${banks.SHADOW?.length} / ストーリー${banks.STORY?.length} / TIP${banks.TIP?.length} (〜第${Math.max(...banks.SENT.map(s=>s.wk))}週)`);
  }
  warns.forEach((w) => console.log("WARN : " + w));
  errors.forEach((e) => console.log("ERROR: " + e));
  console.log(`結果: ERROR ${errors.length}件 / WARN ${warns.length}件`);
  if (errors.length) { console.log("→ ERRORを0件にするまで公開・コミット禁止(CLAUDE.md 大原則2)"); process.exit(1); }
  console.log("→ 合格");
  process.exit(0);
}
