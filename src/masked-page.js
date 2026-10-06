// 掩码查找页面：在编辑器当前内容的快照上，按半字节通配模式 + [start,end)
// 范围发起 Worker 查询。
//
// 结果展示的身份条件（缺一即不展示，避免旧回复 / 旧内容 / 旧查询串台）：
//   1. 回复的序号 === 最近一次发出的序号（连续查询时旧回复不覆盖新查询）；
//   2. 回复绑定的修订号 === 编辑器当前 revision（编辑、撤销、重做后内容已变）；
//   3. 回复回显的模式与范围 === 表单当前的模式与范围（输入变化即作废旧查询）。
// 任何输入变化与任何内容变化都会立即让展示回到“待重新查询”。

import { HexEditor } from "./editor.js";
import { parseMasked, MAX_SNAPSHOT_LEN } from "./masked-search.js";
import { hex2 } from "./util.js";

const $ = (id) => document.getElementById(id);
const editor = new HexEditor();
const worker = new Worker("src/search-worker.js", { type: "module" });
const LIMIT = 1000;

let seq = 0; // 查询序号：单调递增，旧回复一律丢弃
let pendingQuery = null; // 最近一次查询的身份 {pattern, start, end}

const resultEl = $("result");

function invalidate(text = "待重新查询") {
  seq++;
  pendingQuery = null;
  resultEl.textContent = text;
}

// 任何表单输入都立即作废旧查询（不等回复，也不让旧结果停在旁边）
for (const name of ["bytes", "pattern", "start", "end"])
  $(name).addEventListener("input", () => invalidate());

// 编辑、撤销、重做（含本页之外触发的内容变化）都使旧结果失效
editor.subscribe(() => invalidate());

worker.onmessage = ({ data }) => {
  if (data.id !== seq || !pendingQuery) return; // 旧回复或已失效
  if (data.rev !== editor.revision) {
    invalidate("内容已变化（编辑/撤销/重做），请重新查询");
    return;
  }
  if (data.error) {
    // 拒绝回执不带结果字段，身份由 id+rev 确认即可
    pendingQuery = null;
    resultEl.textContent = `查询被拒绝：${data.error}`;
    return;
  }
  if (!sameQuery(data, pendingQuery)) {
    invalidate("回复与当前查询不一致，请重新查询");
    return;
  }
  pendingQuery = null;
  renderResult(data);
};
worker.onerror = (e) => {
  resultEl.textContent = `Worker 错误：${e.message || "未知错误"}，请重新查询`;
};

function sameQuery(data, q) {
  if (data.start !== q.start || data.end !== q.end) return false;
  if (!Array.isArray(data.positions) || !Array.isArray(data.evidence)) return false;
  if (data.positions.length !== data.evidence.length) return false;
  // 逐行校验：绝对位置完整落在回显范围内，且证据字节与当前模式相容。
  for (let i = 0; i < data.positions.length; i++) {
    const p = data.positions[i];
    const ev = data.evidence[i];
    if (!Array.isArray(ev) || ev.length !== q.pattern.length) return false;
    if (!(q.start <= p && p + ev.length <= q.end)) return false;
    for (let j = 0; j < ev.length; j++) {
      if (((ev[j] ^ q.pattern.values[j]) & q.pattern.masks[j]) !== 0)
        return false;
    }
  }
  return true;
}

function renderResult(data) {
  const { positions, evidence, truncated, start, end, total, rev } = data;
  const lines = [];
  lines.push(
    `范围 [${start}, ${end})（快照总长 ${total}，修订 ${rev}）`,
  );
  lines.push(
    truncated
      ? `已达上限 ${LIMIT}：显示前 ${positions.length} 个匹配，仍有匹配被截断`
      : `共 ${positions.length} 个匹配（允许重叠，均完整落在范围内）`,
  );
  positions.forEach((p, i) => {
    lines.push(
      `${String(i + 1).padStart(4)}. @${String(p).padStart(8, "0")}  ${
        evidence[i].map(hex2).join(" ")
      }`,
    );
  });
  resultEl.textContent = lines.join("\n");
}

function parseBoundary(value, fallback) {
  const t = String(value).trim();
  if (t === "") return fallback;
  if (!/^\d+$/.test(t)) throw new Error("范围必须是非负整数");
  return Number(t);
}

$("search").addEventListener("click", () => {
  try {
    // 1) 先校验全部输入——非法表单不得改动文档内容
    const text = $("bytes").value.trim();
    if (!/^(?:[0-9a-f]{2})(?:\s+[0-9a-f]{2})*$/i.test(text))
      throw new Error("字节非法");
    const bytes = Uint8Array.from(
      text.split(/\s+/).map((x) => parseInt(x, 16)),
    );
    if (bytes.length > MAX_SNAPSHOT_LEN)
      throw new Error(`快照 ${bytes.length} 字节，超过 ${MAX_SNAPSHOT_LEN} 上限`);

    const pattern = parseMasked($("pattern").value);
    if (!pattern)
      throw new Error("模式非法：每项两位十六进制或 ?，长度 1..64");

    const start = parseBoundary($("start").value, 0);
    const end = parseBoundary($("end").value, bytes.length);
    if (!(0 <= start && start <= end && end <= bytes.length))
      throw new Error(
        `范围非法：要求 0 ≤ start ≤ end ≤ ${bytes.length}（当前 start=${start}, end=${end}）`,
      );

    // 2) 只有内容确有变化才写入（避免“相同字节再查一次”平白推高修订号）
    if (
      editor.length !== bytes.length ||
      bytes.some((b, i) => editor.doc.byteAt(i) !== b)
    ) {
      editor.splice(0, editor.length, bytes);
    }

    // 3) 快照 + 固定切分（核心搜索按逻辑拼接处理，切分方式不得影响结果）
    const snapshot = editor.doc.toBytes();
    const chunks = [];
    for (let at = 0; at < snapshot.length; at += 4)
      chunks.push(snapshot.slice(at, at + 4));

    const id = ++seq;
    const rev = editor.revision;
    pendingQuery = { pattern, start, end };
    resultEl.textContent = "查询中…";
    worker.postMessage({
      kind: "masked",
      id,
      rev,
      pattern,
      chunks,
      options: { start, end, limit: LIMIT },
    });
  } catch (error) {
    invalidate(String(error.message ?? error));
  }
});
