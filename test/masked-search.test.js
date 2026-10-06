// 掩码搜索测试：半字节通配、跨分段、范围包含、重叠计数、上限/截断、
// 非法输入整次拒绝、分段方式无关性（位置 + 原始字节证据）、Worker 往返。

import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import {
  parseMasked,
  searchMasked,
  MAX_PATTERN_LEN,
  MAX_SNAPSHOT_BYTES,
} from "../src/masked-search.js";
import { HexEditor } from "../src/editor.js";
import { mulberry32, randomBytes } from "./helpers.js";

const hex = (s) =>
  Uint8Array.from(
    s
      .trim()
      .split(/\s+/)
      .map((x) => parseInt(x, 16)),
  );

// 朴素参考实现：在拼接后的数据上按 [start,end) 与掩码逐字节扫描。
function refSearch(data, pattern, start, end, limit) {
  const positions = [];
  const evidence = [];
  let truncated = false;
  scan: for (let i = start; i + pattern.length <= end; i++) {
    for (let j = 0; j < pattern.length; j++) {
      if ((data[i + j] & pattern.masks[j]) !== (pattern.values[j] & pattern.masks[j]))
        continue scan;
    }
    if (positions.length >= limit) {
      truncated = true;
      break;
    }
    positions.push(i);
    evidence.push([...data.slice(i, i + pattern.length)]);
  }
  return { positions, evidence, truncated };
}

/** 按给定点位切分（点位可重复 → 空段；视图带 byteOffset）。 */
function splitAt(data, cuts) {
  const chunks = [];
  let prev = 0;
  for (const c of cuts) {
    chunks.push(data.subarray(prev, c));
    prev = c;
  }
  chunks.push(data.subarray(prev));
  return chunks;
}

test("parseMasked：通配掩码与非法输入", () => {
  const p = parseMasked("A? ?? A2");
  assert.deepEqual([...p.values], [0xa0, 0x00, 0xa2]);
  assert.deepEqual([...p.masks], [0xf0, 0x00, 0xff]);
  assert.equal(p.length, 3);

  for (const bad of ["", "   ", "A", "A??", "GG", "?", " x"])
    assert.equal(parseMasked(bad), null, `非法：${JSON.stringify(bad)}`);

  assert.ok(parseMasked("?? ".repeat(MAX_PATTERN_LEN).trim()));
  assert.equal(parseMasked("?? ".repeat(MAX_PATTERN_LEN + 1).trim()), null);
});

test("半字节通配：? 半字节不参与比较", () => {
  // AF 01 A2 AF 09 A2 —— A? 命中高半字节为 A 的四处；?? 全通配；A? ?? A2 命中 0 与 3
  const data = hex("AF 01 A2 AF 09 A2");
  let r = searchMasked([data], parseMasked("A?"));
  assert.deepEqual(r.positions, [0, 2, 3, 5], "高半字节固定，低半字节通配");
  r = searchMasked([data], parseMasked("?F"));
  assert.deepEqual(r.positions, [0, 3]);
  r = searchMasked([data], parseMasked("A? ?? A2"));
  assert.deepEqual(r.positions, [0, 3]);
  r = searchMasked([data], parseMasked("??"));
  assert.deepEqual(r.positions, [0, 1, 2, 3, 4, 5], "全通配逐条重叠");
  assert.deepEqual(r.truncated, false);
});

test("跨分段：模式跨过任意分段边界都不漏，且位置/证据与分段无关", () => {
  const data = hex("AF 01 A2 AF 09 A2");
  const pattern = parseMasked("AF ?? A2"); // 仅位置 0 命中（AF 01 A2）

  const single = searchMasked([data], pattern);
  assert.deepEqual(single.positions, [0, 3]);
  // 每一种切分方式（边界恰好切进模式内部，1..3 字节一块）
  for (const cut of [1, 2, 3, 4, 5]) {
    const chunks = [];
    for (let at = 0; at < data.length; at += cut)
      chunks.push(data.subarray(at, at + cut));
    const r = searchMasked(chunks, pattern);
    assert.deepEqual(r.positions, single.positions, `切分粒度 ${cut} 位置一致`);
    assert.deepEqual(r.evidence, single.evidence, `切分粒度 ${cut} 证据一致`);
  }
  // 空段、零长切点、带偏移视图同样不改变结果
  const sparse = splitAt(data, [0, 2, 2, 6]);
  assert.ok(sparse.some((c) => c.length === 0));
  assert.ok(sparse.some((c) => c.byteOffset > 0));
  const r2 = searchMasked(sparse, pattern);
  assert.deepEqual(r2.positions, [0, 3]);
  assert.deepEqual(
    r2.evidence,
    [
      [0xaf, 0x01, 0xa2],
      [0xaf, 0x09, 0xa2],
    ],
    "证据是完整原始字节",
  );

  // 段尾不完整的字节不得充作证据（旧实现 chunk.slice 会给出残缺证据）
  const atBoundary = searchMasked(
    [data.subarray(0, 1), data.subarray(1)],
    pattern,
  );
  assert.deepEqual(atBoundary.positions, [0, 3]);
  assert.deepEqual(atBoundary.evidence[0], [0xaf, 0x01, 0xa2]);
  assert.deepEqual(atBoundary.evidence[1], [0xaf, 0x09, 0xa2]);
});

test("片段表自然分段（ORIG→ADD→ORIG）上的跨段命中", () => {
  const ed = new HexEditor(hex("AF 01 A2 AF 09 A2"));
  ed.splice(3, 0, hex("77")); // 中间插入 → 至少三段：ORIG/ADD/ORIG
  assert.ok(ed.doc.pieces.length >= 3);
  const chunks = ed.doc.pieces.map((p) =>
    ed.doc
      .sourceBuffer(p.buf)
      .subarray(p.start, p.start + p.len),
  );
  // 贯穿三段边界的通配模式：A2 ?? AF
  const r = searchMasked(chunks, parseMasked("A2 ?? AF"));
  assert.deepEqual(r.positions, [2], "命中横跨 ORIG→ADD 与 ADD→ORIG 两个边界");
  assert.deepEqual(r.evidence, [[0xa2, 0x77, 0xaf]]);
  assert.deepEqual(
    searchMasked([ed.doc.toBytes()], parseMasked("A2 ?? AF")).positions,
    r.positions,
  );
});

test("范围：只有完整落在 [start,end) 内的命中有效", () => {
  const data = hex("AF 01 A2 AF 09 A2");
  const p = parseMasked("A? ?? A2"); // 命中 0 与 3，长度 3
  assert.deepEqual(searchMasked([data], p, { start: 0, end: 3 }).positions, [0]);
  assert.deepEqual(searchMasked([data], p, { start: 1, end: 6 }).positions, [3]);
  // end=2 时命中 0 的末端 (3) 越界 → 无效
  assert.deepEqual(searchMasked([data], p, { start: 0, end: 2 }).positions, []);
  // start=3 起算：命中 3 有效；空范围合法且无命中
  assert.deepEqual(searchMasked([data], p, { start: 3, end: 3 }).positions, []);
  assert.deepEqual(searchMasked([], p, { start: 0, end: 0 }).positions, []);
  // 范围边缘的单字节全通配
  assert.deepEqual(
    searchMasked([data], parseMasked("??"), { start: 2, end: 4 }).positions,
    [2, 3],
  );
});

test("上限与截断标记：数量准确，truncated 与实际剩余一致", () => {
  const data = hex("AF 01 A2 AF 09 A2");
  const p = parseMasked("??"); // 6 个重叠位置（0..5）
  const r = searchMasked([data], p, { limit: 3 });
  assert.deepEqual(r.positions, [0, 1, 2]);
  assert.equal(r.truncated, true);
  // 恰好等于上限：未截断
  assert.equal(
    searchMasked([data], p, { limit: 6 }).truncated,
    false,
  );
  // 上限+1 也未截断；范围把总数压到上限以内时同样不截断
  assert.equal(searchMasked([data], p, { limit: 7 }).truncated, false);
  assert.deepEqual(
    searchMasked([data], p, { start: 0, end: 3, limit: 5 }).positions,
    [0, 1, 2],
  );
  // 上限 1：只报告第一条，但确实存在剩余
  const one = searchMasked([data], p, { limit: 1 });
  assert.deepEqual(one.positions, [0]);
  assert.equal(one.truncated, true);
});

test("非法描述、边界与上限整次拒绝", () => {
  const data = hex("AF 01 A2");
  assert.throws(() => searchMasked(null, parseMasked("??")), /分段/);
  assert.throws(() => searchMasked(["x"], parseMasked("??")), /Uint8Array/);
  assert.throws(() => searchMasked([data], null), /模式/);
  assert.throws(
    () => searchMasked([data], { values: data, masks: [], length: 1 }),
    /模式/,
  );
  assert.throws(() => searchMasked([data], parseMasked("??"), { start: -1 }), /整数|越界/);
  assert.throws(() => searchMasked([data], parseMasked("??"), { end: 4 }), /越界/);
  assert.throws(
    () => searchMasked([data], parseMasked("??"), { start: 2, end: 1 }),
    /越界/,
  );
  assert.throws(() => searchMasked([data], parseMasked("??"), { limit: 0 }), /上限/);
  assert.throws(() => searchMasked([data], parseMasked("??"), { limit: 1.5 }), /整数/);
  assert.throws(
    () => searchMasked([new Uint8Array(MAX_SNAPSHOT_BYTES + 1)], parseMasked("??")),
    /1 MiB/,
  );
});

test("随机对拍：不同切分不改变位置与字节证据", () => {
  const rng = mulberry32(20261006);
  for (let round = 0; round < 200; round++) {
    const n = Math.floor(rng() * 120);
    const data = randomBytes(rng, n).map((b) => b % 4); // 小字节表 → 多命中多重叠
    const m = 1 + Math.floor(rng() * 6);
    const pattern = parseMasked(
      Array.from({ length: m }, () => {
        const hi = rng() < 0.4 ? "?" : (Math.floor(rng() * 4)).toString(16);
        const lo = rng() < 0.4 ? "?" : (Math.floor(rng() * 4)).toString(16);
        return hi + lo;
      }).join(" "),
    );
    const start = Math.floor(rng() * (n + 1));
    const end = start + Math.floor(rng() * (n - start + 1));
    const limit = 1 + Math.floor(rng() * 30);

    const ref = refSearch(data, pattern, start, end, limit);
    const whole = searchMasked([data], pattern, { start, end, limit });
    assert.deepEqual(whole.positions, ref.positions, `round=${round} 位置`);
    assert.deepEqual(whole.evidence, ref.evidence, `round=${round} 证据`);
    assert.equal(whole.truncated, ref.truncated, `round=${round} 截断`);

    // 随机切点（含重复点=空段、起点 0），结果必须完全一致
    const cuts = Array.from({ length: Math.floor(rng() * 6) }, () =>
      Math.floor(rng() * (n + 1)),
    ).sort((a, b) => a - b);
    const chunked = searchMasked(splitAt(data, cuts), pattern, {
      start,
      end,
      limit,
    });
    assert.deepEqual(chunked.positions, ref.positions, `round=${round} 切分位置`);
    assert.deepEqual(chunked.evidence, ref.evidence, `round=${round} 切分证据`);
    assert.equal(chunked.truncated, ref.truncated, `round=${round} 切分截断`);
    assert.equal(chunked.size, n);
  }
});

test("掩码搜索 Worker 消息往返（绝对位置、证据、截断、非法请求报错）", async () => {
  const worker = new Worker(new URL("../src/search-worker.js", import.meta.url));
  const call = (msg) =>
    new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.postMessage(msg);
    });
  try {
    const ed = new HexEditor(hex("AF 01 A2 AF 09 A2"));
    ed.splice(3, 0, hex("77")); // ORIG / ADD / ORIG
    const chunks = ed.doc.pieces.map((p) =>
      ed.doc.sourceBuffer(p.buf).subarray(p.start, p.start + p.len),
    );
    const pattern = parseMasked("A? ?? A2");

    const ok = await call({
      kind: "masked",
      id: 7,
      rev: ed.revision,
      pattern,
      patternText: "A? ?? A2",
      chunks,
      options: { start: 0, end: ed.length, limit: 1 },
    });
    assert.equal(ok.id, 7);
    assert.equal(ok.rev, ed.revision);
    assert.equal(ok.patternText, "A? ?? A2");
    assert.deepEqual(ok.positions, [0]);
    assert.deepEqual(ok.evidence, [[0xaf, 0x01, 0xa2]]);
    assert.equal(ok.truncated, true);
    assert.equal(ok.size, ed.length);

    const bad = await call({
      kind: "masked",
      id: 8,
      rev: ed.revision,
      pattern,
      patternText: "A? ?? A2",
      chunks,
      options: { start: 0, end: ed.length + 1 },
    });
    assert.equal(bad.id, 8);
    assert.match(bad.error, /越界/);

    // 原精确字节搜索路径保持可用
    const snapshot = ed.doc.toBytes();
    const exact = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.postMessage(
        { id: 9, rev: ed.revision, pattern: hex("AF 01"), buffer: snapshot.buffer },
        [snapshot.buffer],
      );
    });
    assert.deepEqual(exact.positions, [0]);
  } finally {
    await worker.terminate();
  }
});
