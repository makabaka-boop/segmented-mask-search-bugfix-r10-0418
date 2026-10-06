import { HexEditor } from "./editor.js";
import { parseMasked } from "./masked-search.js";
const $ = (id) => document.getElementById(id),
  editor = new HexEditor();
const worker = new Worker("src/search-worker.js", { type: "module" });
let id = 0;
for (const name of ["bytes", "pattern", "start", "end"])
  $(name).oninput = () => {
    id++;
    $("result").textContent = "待重新查询";
  };
worker.onmessage = ({ data }) => {
  if (data.id !== id || data.rev !== editor.revision) return;
  $("result").textContent = JSON.stringify(data, null, 2);
};
$("search").onclick = () => {
  try {
    const text = $("bytes").value.trim();
    if (!/^(?:[0-9a-f]{2})(?:\s+[0-9a-f]{2})*$/i.test(text))
      throw new Error("字节非法");
    const bytes = Uint8Array.from(
      text.split(/\s+/).map((x) => parseInt(x, 16)),
    );
    editor.splice(0, editor.length, bytes);
    const snapshot = editor.doc.toBytes(),
      chunks = [];
    for (let at = 0; at < snapshot.length; at += 4)
      chunks.push(snapshot.slice(at, at + 4));
    const pattern = parseMasked($("pattern").value);
    if (!pattern) throw new Error("模式非法");
    worker.postMessage({
      kind: "masked",
      id: ++id,
      rev: editor.revision,
      pattern,
      chunks,
      options: {
        start: Number($("start").value),
        end: Number($("end").value),
        limit: 1000,
      },
    });
  } catch (error) {
    $("result").textContent = String(error);
  }
};
