// 「掩码字节查找」复核页：在 PieceTable 当前修订的字节快照上，按半字节通配
// 模式查询指定范围。Worker 返回绝对位置 + 原始匹配字节，结果同时绑定：
//   - 请求序号 id（连续查询时旧回复不覆盖新查询）；
//   - 编辑修订号 rev（编辑 / 撤销后旧结果不再显示在新内容旁）；
//   - 查询身份（模式、范围、上限、快照规模），输入变化立即失效。

import { HexEditor } from "./editor.js";
import { ORIG } from "./piece-table.js";
import { parseMasked } from "./masked-search.js";

const $ = (id) => document.getElementById(id);
const editor = new HexEditor();
const worker = new Worker("src/search-worker.js", { type: "module" });
const LIMIT = 1000;

let id = 0;
let pending = null; // {id, rev, patternText, start, end, size}

/** 当前四个输入中任意一个变化：结果立即失效，必须重新查询。 */
for (const name of ["bytes", "pattern", "start", "end"])
  $(name).oninput = () => {
    id++;
    pending = null;
    $("result").textContent = "待重新查询";
  };

const parseByteList = (text) => {
  const t = text.trim();
  if (!/^(?:[0-9a-f]{2})(?:\s+[0-9a-f]{2})*$/i.test(t))
    throw new Error("字节非法");
  return Uint8Array.from(t.split(/\s+/).map((x) => parseInt(x, 16)));
};

const readRange = (size) => {
  const rawStart = $("start").value.trim();
  const rawEnd = $("end").value.trim();
  const start = rawStart === "" ? 0 : Number(rawStart);
  const end = rawEnd === "" ? size : Number(rawEnd);
  if (!Number.isInteger(start) || !Number.isInteger(end))
    throw new Error("起点、终点必须是整数");
  if (start < 0 || end < start || end > size) throw new Error("范围越界");
  return { start, end };
};

/** 仅当快照字节确有变化时才替换文档，避免无意义地推进修订号。 */
const syncDocument = (bytes) => {
  if (editor.length === bytes.length) {
    let same = true;
    for (let i = 0; i < bytes.length; i++) {
      if (editor.doc.byteAt(i) !== bytes[i]) {
        same = false;
        break;
      }
    }
    if (same) return;
  }
  editor.splice(0, editor.length, bytes);
};

/** 取片段表当前修订的自然分段（ORIG/ADD 视图，可能带 byteOffset，允许空）。 */
const snapshotChunks = () =>
  editor.doc.pieces.map((p) =>
    editor.doc
      .sourceBuffer(p.buf === ORIG ? 0 : 1)
      .subarray(p.start, p.start + p.len),
  );

const hexdump = (bs) => bs.map((b) => b.toString(16).padStart(2, "0")).join(" ");

function renderResult(data) {
  const lines = [
    `共返回 ${data.positions.length} 个匹配（修订 ${data.rev}，范围 [${data.start}, ${data.end})）`,
    data.truncated
      ? `已达上限 ${data.limit}，范围内尚有更多匹配未返回（结果已截断）`
      : "未截断：范围内全部匹配均已返回",
    "",
  ];
  data.positions.forEach((pos, i) => {
    lines.push(`#${i + 1}  绝对位置 ${pos}  实际字节 ${hexdump(data.evidence[i])}`);
  });
  $("result").textContent = lines.join("\n");
}

worker.onmessage = ({ data }) => {
  // 身份校验缺一不可：序号、修订号、查询参数与快照规模全部对应当前查询才展示。
  if (!pending || data.id !== pending.id || data.id !== id) return;
  if (data.rev !== editor.revision || data.rev !== pending.rev) {
    $("result").textContent = "内容已变化（修订不符），请重新查询";
    pending = null;
    return;
  }
  if (
    data.patternText !== pending.patternText ||
    data.start !== pending.start ||
    data.end !== pending.end ||
    data.size !== pending.size ||
    data.limit !== LIMIT
  )
    return;
  pending = null;
  if (data.error) {
    $("result").textContent = data.error;
    return;
  }
  renderResult(data);
};

$("search").onclick = () => {
  try {
    const bytes = parseByteList($("bytes").value);
    syncDocument(bytes);
    const patternText = $("pattern").value;
    const pattern = parseMasked(patternText);
    if (!pattern) throw new Error("模式非法（每项两位十六进制或 ?，1..64 项）");
    const { start, end } = readRange(editor.length);
    const chunks = snapshotChunks();
    const myId = ++id;
    pending = {
      id: myId,
      rev: editor.revision,
      patternText,
      start,
      end,
      size: editor.length,
    };
    $("result").textContent = "查询中…";
    worker.postMessage({
      kind: "masked",
      id: myId,
      rev: editor.revision,
      pattern,
      patternText,
      chunks,
      options: { start, end, limit: LIMIT },
    });
  } catch (error) {
    id++;
    pending = null;
    $("result").textContent = String(error.message ?? error);
  }
};
