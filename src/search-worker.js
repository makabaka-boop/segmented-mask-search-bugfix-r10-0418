// 搜索 Worker：接收绑定修订号的搜索请求，返回命中位置。
// 消息协议：
//   入（精确查找）: {id, rev, pattern: Uint8Array, buffer: ArrayBuffer}
//                   （buffer 为文档快照，已转移所有权）
//   入（掩码查找）: {kind:"masked", id, rev, pattern:{values,masks,length},
//                    chunks: Uint8Array[], options:{start,end,limit}}
//   出: {id, rev, positions, ...}（掩码另含 evidence/truncated/范围回显）
// 非法掩码请求整次拒绝：{id, rev, error}，不返回部分结果。
// 同时兼容浏览器（self）与 Node worker_threads（便于测试）。

import { findAll } from "./search-core.js";
import { searchMasked } from "./masked-search.js";

let post;
let listen;
if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  post = (msg) => self.postMessage(msg);
  listen = (fn) => {
    self.onmessage = (e) => fn(e.data);
  };
} else {
  const { parentPort } = await import("node:worker_threads");
  post = (msg) => parentPort.postMessage(msg);
  listen = (fn) => parentPort.on("message", fn);
}

listen((msg) => {
  if (msg.kind === "masked") {
    try {
      post({
        id: msg.id,
        rev: msg.rev,
        ...searchMasked(msg.chunks, msg.pattern, msg.options),
      });
    } catch (error) {
      post({ id: msg.id, rev: msg.rev, error: String(error.message ?? error) });
    }
    return;
  }
  const { id, rev, pattern, buffer } = msg;
  const positions = findAll(new Uint8Array(buffer), pattern);
  post({ id, rev, positions });
});
