// 半字节通配字节模式搜索（masked search）。
//
// 输入是片段表当前修订的字节快照，以「有序、连续、互不重叠」的 Uint8Array
// 分段形式给出（空段合法）。搜索语义与分段方式无关：先按顺序拼接分段，所有
// 命中位置一律按整份快照的绝对偏移报告，证据（实际匹配字节）取自拼接后的
// 快照——因此任意重新切分（按片段表自然分段 / 定长切片 / 单段）都得到完全
// 相同的位置与原始字节。
//
// 模式每项为两位十六进制或 ?（按半字节通配）；只有完整落在 [start,end) 内
// 的命中有效（重叠命中逐条计入）；至多返回 limit 条，并如实报告是否尚有命中
// 被截断。非法描述 / 边界 / 上限整次拒绝（抛错），不返回部分结果。

export const MAX_PATTERN_LEN = 64;
export const MAX_SNAPSHOT_BYTES = 1 << 20; // 1 MiB

/**
 * 解析掩码模式文本。
 * @param {string} text 以空白分隔的 1..64 个令牌，每令牌两位十六进制或 ?
 *   （如 "A? ?? A2"）；? 表示对应半字节通配。
 * @returns {{values:Uint8Array, masks:Uint8Array, length:number}|null}
 *   values 为固定半字节拼成的字节（通配半字节处为 0），masks 中 0xF0/0x0F
 *   位表示该半字节是否固定；非法返回 null。
 */
export function parseMasked(text) {
  const tokens = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 1 || tokens.length > MAX_PATTERN_LEN) return null;
  const values = [];
  const masks = [];
  for (const token of tokens) {
    if (!/^[0-9a-f?]{2}$/i.test(token)) return null;
    values.push(parseInt(token.replaceAll("?", "0"), 16));
    masks.push((token[0] === "?" ? 0 : 0xf0) | (token[1] === "?" ? 0 : 0x0f));
  }
  return {
    values: Uint8Array.from(values),
    masks: Uint8Array.from(masks),
    length: values.length,
  };
}

const isInt = (v) => typeof v === "number" && Number.isInteger(v);

/**
 * 在分段快照上执行掩码搜索。
 * @param {Iterable<Uint8Array>} chunks 有序连续分段（允许空段与带 byteOffset 的视图）
 * @param {{values:Uint8Array, masks:Uint8Array, length:number}} pattern parseMasked 的结果
 * @param {{start?:number, end?:number, limit?:number}} [options]
 *   start/end 限定半开区间 [start,end)，只有「完整」落在区间内的命中有效；
 *   start 默认 0、end 默认快照总长；limit 默认 1000，必须 >= 1。
 * @returns {{positions:number[], evidence:number[][], truncated:boolean,
 *            start:number, end:number, limit:number, size:number}}
 *   positions 升序、可重叠；evidence[i] 为 positions[i] 处实际匹配到的完整字节；
 *   truncated=true 表示区间内仍有命中因达上限未返回。
 */
export function searchMasked(chunks, pattern, options) {
  const opts = options ?? {};

  // ---- 模式描述校验（整次拒绝，不返回部分结果）----
  if (!pattern || !isInt(pattern.length)) throw new Error("模式描述非法");
  const m = pattern.length;
  if (m < 1 || m > MAX_PATTERN_LEN)
    throw new Error(`模式长度须在 1..${MAX_PATTERN_LEN} 字节之间`);
  if (
    !(pattern.values instanceof Uint8Array) ||
    !(pattern.masks instanceof Uint8Array) ||
    pattern.values.length < m ||
    pattern.masks.length < m
  )
    throw new Error("模式描述非法");

  // ---- 分段描述校验 ----
  if (!chunks || typeof chunks[Symbol.iterator] !== "function")
    throw new Error("分段描述非法");
  const list = Array.from(chunks);
  let size = 0;
  for (const c of list) {
    if (!(c instanceof Uint8Array)) throw new Error("分段必须是 Uint8Array");
    size += c.length;
  }
  if (size > MAX_SNAPSHOT_BYTES) throw new Error("快照总量超过 1 MiB 上限");

  // ---- 范围与上限校验 ----
  const start = opts.start === undefined ? 0 : opts.start;
  const end = opts.end === undefined ? size : opts.end;
  const limit = opts.limit === undefined ? 1000 : opts.limit;
  if (!isInt(start) || !isInt(end) || !isInt(limit))
    throw new Error("起点、终点与上限必须是整数");
  if (start < 0 || end < start || end > size) throw new Error("范围越界");
  if (limit < 1) throw new Error("上限必须 >= 1");

  // ---- 按序拼接：此后匹配与原始分段方式完全无关 ----
  const data = new Uint8Array(size);
  let off = 0;
  for (const c of list) {
    data.set(c, off); // set 正确处理带 byteOffset 的视图
    off += c.length;
  }

  // 命中起点 i 必须满足 [start,end) 完整包住 [i,i+m)：start <= i 且 i+m <= end
  const { values, masks } = pattern;
  const positions = [];
  const evidence = [];
  let truncated = false;
  const last = end - m; // 同时隐含 i+m <= end <= size
  scan: for (let i = start; i <= last; i++) {
    for (let j = 0; j < m; j++) {
      if ((data[i + j] & masks[j]) !== (values[j] & masks[j])) continue scan;
    }
    if (positions.length >= limit) {
      // 又确认了一条区间内的真实命中 → 上限提示与剩余情况才一致
      truncated = true;
      break;
    }
    positions.push(i);
    evidence.push(Array.from(data.subarray(i, i + m)));
  }

  return { positions, evidence, truncated, start, end, limit, size };
}
