// 半字节通配字节搜索（掩码查找）。
//
// 模式每项是两位十六进制或 ?（半字节通配），长度 1..64；Worker 接收的是
// **有序的 Uint8Array 分段**。搜索前先把分段逻辑拼接到一份连续视图上，
// 因此命中位置始终是拼接快照的绝对偏移、证据始终取自快照原始字节，
// 与调用方如何分段（切几刀、在哪里切、是否夹带空片段）无关。
//
// 范围 [start, end)：只有完整落在范围内的命中（start <= p 且 p+m <= end）
// 才有效；命中允许重叠（逐位置步进 1）；至多返回 limit 个，并且只有在
// 确实发现第 limit+1 个命中时才把 truncated 置为 true。
//
// 非法描述 / 边界 / 上限一律抛错，由 Worker 捕获后整次拒绝（不会返回
// 半成品结果）。

export const MAX_PATTERN_LEN = 64;
export const MAX_SNAPSHOT_LEN = 1 << 20; // 总快照至多 1 MiB

/**
 * 解析 "A? ?? A2" 形式的模式；非法或超长返回 null（空串也是 null）。
 * values 的通配半字节填 0（无意义，匹配时被 masks 屏蔽），
 * masks 每位为 0xF 表示该半字节固定、0x0 表示通配。
 */
export function parseMasked(text) {
  const tokens = String(text ?? "").trim().split(/\s+/);
  if (tokens.length === 1 && tokens[0] === "") return null;
  const values = [];
  const masks = [];
  for (const token of tokens) {
    if (!/^[0-9a-f?]{2}$/i.test(token)) return null;
    const hi = token[0];
    const lo = token[1];
    values.push(
      ((hi === "?" ? 0 : parseInt(hi, 16)) << 4) |
        (lo === "?" ? 0 : parseInt(lo, 16)),
    );
    masks.push((hi === "?" ? 0 : 0xf0) | (lo === "?" ? 0 : 0x0f));
  }
  if (values.length === 0 || values.length > MAX_PATTERN_LEN) return null;
  return {
    values: Uint8Array.from(values),
    masks: Uint8Array.from(masks),
    length: values.length,
  };
}

/** 校验一个掩码搜索请求；任何一项不合法都抛错（整次拒绝，不返回部分结果）。 */
export function validateMaskedRequest(chunks, pattern, options = {}) {
  if (!Array.isArray(chunks) || !chunks.every((c) => c instanceof Uint8Array))
    throw new Error("chunks 必须是有序的 Uint8Array 数组（空片段合法）");

  if (
    !pattern ||
    !(pattern.values instanceof Uint8Array) ||
    !(pattern.masks instanceof Uint8Array) ||
    pattern.values.length !== pattern.masks.length ||
    pattern.values.length === 0 ||
    pattern.values.length > MAX_PATTERN_LEN
  )
    throw new Error(`模式非法：values/masks 须为等长 Uint8Array，长度 1..${MAX_PATTERN_LEN}`);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total > MAX_SNAPSHOT_LEN)
    throw new Error(`快照总长 ${total} 超过 ${MAX_SNAPSHOT_LEN} 字节上限`);

  const start = options.start ?? 0;
  const end = options.end ?? total;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > total
  )
    throw new Error("范围非法：要求 0 ≤ start ≤ end ≤ 快照长度的整数");

  const limit = options.limit ?? Infinity;
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1))
    throw new Error("上限非法：limit 必须为正整数");

  return { total, start, end, limit };
}

/**
 * 在分段快照上执行掩码搜索。
 * @param {Uint8Array[]} chunks 有序分段（允许零长片段），逻辑上首尾相接
 * @param {{values:Uint8Array, masks:Uint8Array, length:number}} pattern
 * @param {{start?:number, end?:number, limit?:number}} options
 *        范围 [start,end)，默认整个快照；limit 默认不限。
 * @returns {{positions:number[], evidence:number[][], truncated:boolean,
 *            total:number, start:number, end:number}}
 */
export function searchMasked(chunks, pattern, options = {}) {
  const { total, start, end, limit } = validateMaskedRequest(
    chunks,
    pattern,
    options,
  );
  const m = pattern.values.length;
  const { values, masks } = pattern;

  // 逻辑拼接：分段只决定投喂方式，不改变任何绝对位置或字节证据。
  // flat.set 按视图的 byteOffset/length 复制，切片视图也安全。
  const flat = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    flat.set(c, off);
    off += c.length;
  }

  const positions = [];
  const evidence = [];
  let truncated = false;

  const record = (i) => {
    positions.push(i);
    evidence.push(Array.from(flat.subarray(i, i + m)));
  };

  // 全通配快速路径：每个位置都命中（含重叠），无需逐字节比较。
  if (masks.every((x) => x === 0)) {
    for (let i = start; i + m <= end; i++) {
      if (positions.length >= limit) {
        truncated = true;
        break;
      }
      record(i);
    }
    return { positions, evidence, truncated, total, start, end };
  }

  // 逐位置步进 1（重叠命中都要），按掩码比较：(b^v)&mask===0。
  scan: for (let i = start; i + m <= end; i++) {
    for (let j = 0; j < m; j++) {
      if (((flat[i + j] ^ values[j]) & masks[j]) !== 0) continue scan;
    }
    // 先确认到第 limit+1 个命中再截断，保证 truncated 与“是否仍有剩余”严格一致。
    if (positions.length >= limit) {
      truncated = true;
      break;
    }
    record(i);
  }
  return { positions, evidence, truncated, total, start, end };
}
