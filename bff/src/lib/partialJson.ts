/**
 * Incremental readers over a JSON object that is still being streamed by a model.
 * They only ever return values that are COMPLETE in the text so far, so a UI can show
 * items as they are extracted without guessing at a half-written string.
 */

/** Index just after `"key": [` or -1. */
function arrayStart(text: string, key: string): number {
  const re = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*\\[`);
  const m = re.exec(text);
  return m ? m.index + m[0].length : -1;
}

/** Complete string elements of `"key": ["a", "b", ...` (the array may be unterminated). */
export function completedStrings(text: string, key: string): string[] {
  let i = arrayStart(text, key);
  if (i < 0) return [];
  const out: string[] = [];
  while (i < text.length) {
    const c = text[i];
    if (c === "]") break;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) break; // unterminated: not complete yet
      try {
        out.push(JSON.parse(text.slice(i, j + 1)));
      } catch {
        /* malformed element: skip */
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

/** Complete object elements of `"key": [{...}, {...` (the array may be unterminated). */
export function completedObjects<T = any>(text: string, key: string): T[] {
  let i = arrayStart(text, key);
  if (i < 0) return [];
  const out: T[] = [];
  while (i < text.length) {
    const c = text[i];
    if (c === "]") break;
    if (c !== "{") {
      i++;
      continue;
    }
    let depth = 0;
    let j = i;
    let inStr = false;
    for (; j < text.length; j++) {
      const d = text[j];
      if (inStr) {
        if (d === "\\") j++;
        else if (d === '"') inStr = false;
      } else if (d === '"') inStr = true;
      else if (d === "{") depth++;
      else if (d === "}" && --depth === 0) break;
    }
    if (j >= text.length) break;
    try {
      out.push(JSON.parse(text.slice(i, j + 1)));
    } catch {
      /* malformed element: skip */
    }
    i = j + 1;
  }
  return out;
}
