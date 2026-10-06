// 掩码查找测试：半字节通配、跨分段命中、范围与重叠、上限截断标记、
// 非法请求整次拒绝、分段方式不改变绝对位置与字节证据、Worker 往返。

import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import {
  parseMasked,
  searchMasked,
  MAX_PATTERN_LEN,
  MAX_SNAPSHOT_LEN,
} from "../src/masked-search.js";
import { mulberry32, randomBytes } from "./helpers.js";

const B = (...xs) => Uint8Array.from(xs);
const chunk = (bytes, size) => {
  const out = [];
  for (let i = 0; i < bytes.length; i += size)
    out.push(bytes.subarray(i, i + size));
  return out;
};

/** 朴素参考实现：在 [start,end) 内逐位置步进 1，按掩码比较。 */
function refSearch(flat, pattern, start, end, limit = Infinity) {
  const m = pattern.length;
  const positions = [];
  let truncated = false;
  scan: for (let i = start; i + m <= end; i++) {
    for (let j = 0; j < m; j++) {
      if (((flat[i + j] ^ pattern.values[j]) & pattern.masks[j]) !== 0)
        continue scan;
    }
    if (positions.length >= limit) {
      truncated = true;
      break;
    }
    positions.push(i);
  }
  return { positions, truncated };
}

test("parseMasked：半字节掩码解析与非法输入", () => {
  const p = parseMasked("A? ?? A2");
  assert.deepEqual([...p.values], [0xa0, 0x00, 0xa2]);
  assert.deepEqual([...p.masks], [0xf0, 0x00, 0xff]);
  assert.equal(p.length, 3);
  assert.deepEqual([...parseMasked("??").masks], [0x00]);
  for (const bad of ["", "   ", "A", "AAA", "X?", "?G", "a? b"])
    assert.equal(parseMasked(bad), null, `bad=${JSON.stringify(bad)}`);
  // a? 合法；65 项超长非法
  assert.ok(parseMasked("a?"));
  assert.equal(parseMasked(Array(MAX_PATTERN_LEN + 1).fill("??").join(" ")), null);
  assert.ok(parseMasked(Array(MAX_PATTERN_LEN).fill("??").join(" ")));
});

test("通配符不会被当成固定字节", () => {
  // AF 01 A2 AF 09 A2 —— 模式 A? ?? A2：第 0 与第 3 字节都应命中
  const flat = B(0xaf, 0x01, 0xa2, 0xaf, 0x09, 0xa2);
  const p = parseMasked("A? ?? A2");
  const r = searchMasked([flat], p, {});
  assert.deepEqual(r.positions, [0, 3]);
  assert.deepEqual(r.evidence, [
    [0xaf, 0x01, 0xa2],
    [0xaf, 0x09, 0xa2],
  ]);
  assert.equal(r.truncated, false);
  // 全通配模式：每个位置都是命中
  assert.deepEqual(searchMasked([B(1, 2, 3)], parseMasked("??"), {}).positions, [
    0, 1, 2,
  ]);
});

test("跨分段命中：切分方式不改变绝对位置与原始字节证据", () => {
  const flat = B(0xaf, 0x01, 0xa2, 0xaf, 0x09, 0xa2, 0xaf, 0x10, 0xa2);
  const p2 = parseMasked("AF ?? A2");
  // 位置 0/3/6 全部命中，逐一跨过各种切法
  const expected = [0, 3, 6];
  for (const size of [1, 2, 3, 4, 5, 7, 100]) {
    const chunks = chunk(flat, size);
    const r = searchMasked(chunks, p2, {});
    assert.deepEqual(r.positions, expected, `size=${size}`);
    assert.deepEqual(
      r.evidence,
      expected.map((q) => Array.from(flat.subarray(q, q + 3))),
      `evidence size=${size}`,
    );
    assert.deepEqual(r.total, flat.length);
  }
  // 夹带空片段同样合法
  const r = searchMasked([B(), flat.subarray(0, 2), B(), flat.subarray(2)], p2, {});
  assert.deepEqual(r.positions, expected);
  assert.deepEqual(r.evidence, expected.map((q) => [0xaf, flat[q + 1], 0xa2]));

  // 精确半字节：?1 只约束低半字节为 1，高半字节任意（01、F1 都中，02 不中）
  const p = parseMasked("AF ?1 A2");
  const flat2 = B(0xaf, 0x02, 0xa2, 0xaf, 0x01, 0xa2, 0xaf, 0xf1, 0xa2);
  assert.deepEqual(searchMasked(chunk(flat2, 1), p, {}).positions, [3, 6]);
  assert.deepEqual(searchMasked(chunk(flat2, 4), p, {}).evidence, [
    [0xaf, 0x01, 0xa2],
    [0xaf, 0xf1, 0xa2],
  ]);
});

test("范围：只有完整落在 [start,end) 内的命中有效", () => {
  // 重复模式，命中位置 0,1,2,3（长度 3，在长度 6 的重复字节上）
  const flat = B(0xa0, 0xa0, 0xa0, 0xa0, 0xa0, 0xa0);
  const p = parseMasked("A0 A0 A0");
  // 全集 [0,6) → 0..3
  assert.deepEqual(searchMasked([flat], p, {}).positions, [0, 1, 2, 3]);
  // [1,6) → 1,2,3（位置 0 未完整包含）
  assert.deepEqual(
    searchMasked([flat], p, { start: 1, end: 6 }).positions,
    [1, 2, 3],
  );
  // [0,5) → 0,1,2（位置 3 延伸到 6，超出 end=5）
  assert.deepEqual(
    searchMasked([flat], p, { start: 0, end: 5 }).positions,
    [0, 1, 2],
  );
  // [2,5) → 只有位置 2（2..5 完整；位置 1 起点越界、位置 3 末端越界）
  assert.deepEqual(
    searchMasked([flat], p, { start: 2, end: 5 }).positions,
    [2],
  );
  // 空范围
  assert.deepEqual(
    searchMasked([flat], p, { start: 3, end: 3 }).positions,
    [],
  );
  // 模式比范围长
  assert.deepEqual(
    searchMasked([flat], p, { start: 0, end: 2 }).positions,
    [],
  );
  // 跨切分边界 + 范围同时作用
  assert.deepEqual(
    searchMasked(chunk(flat, 2), p, { start: 1, end: 6 }).positions,
    [1, 2, 3],
  );
});

test("上限与截断标记：truncated 与是否仍有剩余严格一致", () => {
  const flat = B(0, 0, 0, 0, 0);
  const p = parseMasked("00 00"); // 命中 0..3
  let r = searchMasked([flat], p, { limit: 2 });
  assert.deepEqual(r.positions, [0, 1]);
  assert.equal(r.truncated, true, "后面还剩 2 个 → 必须标记截断");
  assert.deepEqual(r.evidence, [
    [0, 0],
    [0, 0],
  ]);

  r = searchMasked([flat], p, { limit: 4 });
  assert.deepEqual(r.positions, [0, 1, 2, 3]);
  assert.equal(r.truncated, false, "恰好取完，不得误报截断");

  r = searchMasked([flat], p, { limit: 10 });
  assert.deepEqual(r.positions, [0, 1, 2, 3]);
  assert.equal(r.truncated, false, "上限大于总数也不得误报");

  // 全通配快速路径同样遵守
  const all = searchMasked([B(7, 8, 9)], parseMasked("??"), { limit: 2 });
  assert.deepEqual(all.positions, [0, 1]);
  assert.equal(all.truncated, true);
  const all2 = searchMasked([B(7, 8)], parseMasked("??"), { limit: 2 });
  assert.equal(all2.truncated, false);

  // limit=1 时仍须先确认真实存在第二个命中才截断
  assert.equal(
    searchMasked([B(0, 0, 0)], p, { limit: 1 }).truncated,
    true,
  );
  assert.equal(
    searchMasked([B(0, 0)], p, { limit: 1 }).truncated,
    false,
  );
});

test("非法描述 / 边界 / 上限：整次拒绝（抛错，无部分结果）", () => {
  const p = parseMasked("AB ??");
  assert.throws(() => searchMasked(null, p, {}), /Uint8Array/);
  assert.throws(() => searchMasked([[1, 2]], p, {}), /Uint8Array/);
  assert.throws(
    () => searchMasked([B(1)], { values: B(1), masks: B(0xff, 0) }, {}),
    /模式非法/,
  );
  assert.throws(
    () => searchMasked([B(1)], { values: new Uint8Array(0), masks: new Uint8Array(0) }, {}),
    /模式非法/,
  );
  const flat = B(0, 1, 2);
  assert.throws(
    () => searchMasked([flat], p, { start: -1, end: 2 }),
    /范围非法/,
  );
  assert.throws(
    () => searchMasked([flat], p, { start: 2, end: 1 }),
    /范围非法/,
  );
  assert.throws(
    () => searchMasked([flat], p, { start: 0, end: 9 }),
    /范围非法/,
  );
  assert.throws(
    () => searchMasked([flat], p, { start: 1.5, end: 2 }),
    /范围非法/,
  );
  for (const bad of [0, -1, 1.5, NaN])
    assert.throws(
      () => searchMasked([flat], p, { limit: bad }),
      /上限非法/,
    );
  assert.throws(
    () => searchMasked([new Uint8Array(MAX_SNAPSHOT_LEN + 1)], p, {}),
    /超过/,
  );
});

test("空片段与空文档", () => {
  const p = parseMasked("??");
  const r = searchMasked([], p, {});
  assert.deepEqual(r.positions, []);
  assert.deepEqual(r.evidence, []);
  assert.equal(r.truncated, false);
  assert.equal(r.total, 0);
  assert.deepEqual(searchMasked([B(), B()], p, {}).positions, []);
});

test("随机对拍：不同切分 + 随机掩码/范围/上限与朴素实现一致", () => {
  const rng = mulberry32(909);
  for (let round = 0; round < 300; round++) {
    const n = Math.floor(rng() * 80);
    const flat = randomBytes(rng, n).map((b) => b % 4);
    const m = 1 + Math.floor(rng() * Math.min(5, Math.max(1, n + 2)));
    const values = randomBytes(rng, m).map((b) => b % 4);
    const masks = Uint8Array.from(randomBytes(rng, m), (b) =>
      b % 3 === 0 ? 0 : b % 3 === 1 ? 0xf0 : 0xff,
    );
    const pattern = { values, masks, length: m };
    const start = Math.floor(rng() * (n + 1));
    const end = start + Math.floor(rng() * (n - start + 1));
    const limit = rng() < 0.4 ? 1 + Math.floor(rng() * 6) : Infinity;

    const size = 1 + Math.floor(rng() * 7);
    const chunks = [];
    for (let i = 0; i < n; chunks.push(flat.subarray(i, i + size)), i += size) {
      if (rng() < 0.1) chunks.push(B()); // 随机插入空片段
    }
    const got = searchMasked(chunks, pattern, { start, end, limit });
    const ref = refSearch(flat, pattern, start, end, limit);
    assert.deepEqual(got.positions, ref.positions, `round=${round} positions`);
    assert.equal(got.truncated, ref.truncated, `round=${round} truncated`);
    // 证据必须来自快照原始字节
    for (let i = 0; i < got.positions.length; i++) {
      const q = got.positions[i];
      assert.deepEqual(
        got.evidence[i],
        Array.from(flat.subarray(q, q + m)),
        `round=${round} evidence@${q}`,
      );
      assert.ok(start <= q && q + m <= end, `round=${round} range`);
    }
  }
});

test("掩码 Worker 往返：命中/拒绝/旧序号互不干扰", async () => {
  const worker = new Worker(
    new URL("../src/search-worker.js", import.meta.url),
  );
  try {
    const flat = B(0xaf, 0x01, 0xa2, 0xaf, 0x09, 0xa2);
    const pattern = parseMasked("A? ?? A2");
    const call = (msg) =>
      new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.postMessage(msg);
      });

    const ok = await call({
      kind: "masked",
      id: 7,
      rev: 3,
      pattern,
      chunks: chunk(flat, 4),
      options: { start: 0, end: 6, limit: 1000 },
    });
    assert.equal(ok.id, 7);
    assert.equal(ok.rev, 3);
    assert.deepEqual(ok.positions, [0, 3]);
    assert.deepEqual(ok.evidence, [
      [0xaf, 0x01, 0xa2],
      [0xaf, 0x09, 0xa2],
    ]);
    assert.equal(ok.truncated, false);

    const cut = await call({
      kind: "masked",
      id: 8,
      rev: 3,
      pattern: parseMasked("?? ??"),
      chunks: chunk(flat, 3),
      options: { start: 0, end: 6, limit: 2 },
    });
    assert.deepEqual(cut.positions, [0, 1]);
    assert.equal(cut.truncated, true);

    const bad = await call({
      kind: "masked",
      id: 9,
      rev: 3,
      pattern,
      chunks: chunk(flat, 4),
      options: { start: 5, end: 1 },
    });
    assert.equal(bad.id, 9);
    assert.match(bad.error, /范围非法/);
    assert.equal(bad.positions, undefined, "拒绝时不得附带部分结果");
  } finally {
    await worker.terminate();
  }
});
