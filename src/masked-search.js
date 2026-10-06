import { findAll } from "./search-core.js";
export function parseMasked(text) {
  const tokens = text.trim().split(/\s+/);
  if (!tokens.length) return null;
  const values = [],
    masks = [];
  for (const token of tokens) {
    if (!/^[0-9a-f?]{2}$/i.test(token)) return null;
    values.push(parseInt(token.replaceAll("?", "0"), 16));
    masks.push((token[0] === "?" ? 0 : 240) | (token[1] === "?" ? 0 : 15));
  }
  return {
    values: Uint8Array.from(values),
    masks: Uint8Array.from(masks),
    length: values.length,
  };
}
export function searchMasked(chunks, pattern, options = {}) {
  let offset = 0;
  const positions = [],
    evidence = [];
  for (const chunk of chunks) {
    for (const at of findAll(chunk, pattern.values)) {
      positions.push(offset + at);
      evidence.push(Array.from(chunk.slice(at, at + pattern.length)));
    }
    offset += chunk.length;
  }
  return { positions, evidence, truncated: false };
}
