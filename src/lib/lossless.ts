// Lossless JSON parsing for eredu record payloads.
//
// eredu emits exact 64-bit integers (sequence numbers, byte counts, capture
// tensor values). JSON.parse would round anything above 2^53 through f64, so
// before parsing we rewrite every oversized integer literal *outside strings*
// into a quoted decimal string. Downstream code treats such fields as
// `number | string` (type I64) and formats them without arithmetic.

export type I64 = number | string;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = -MAX_SAFE;

export function parseLossless(json: string): unknown {
  return JSON.parse(rewriteBigIntegers(json));
}

export function rewriteBigIntegers(json: string): string {
  let out: string[] | null = null;
  let copiedTo = 0;
  let i = 0;
  const n = json.length;
  let inString = false;

  while (i < n) {
    const ch = json.charCodeAt(i);
    if (inString) {
      if (ch === 92 /* backslash */) {
        i += 2;
        continue;
      }
      if (ch === 34 /* quote */) inString = false;
      i++;
      continue;
    }
    if (ch === 34 /* quote */) {
      inString = true;
      i++;
      continue;
    }
    // A number literal can begin with '-' or a digit.
    const isDigit = ch >= 48 && ch <= 57;
    if (!isDigit && ch !== 45 /* minus */) {
      i++;
      continue;
    }
    // Scan the full number literal.
    let j = i;
    if (json.charCodeAt(j) === 45) j++;
    const intStart = j;
    while (j < n) {
      const d = json.charCodeAt(j);
      if (d >= 48 && d <= 57) j++;
      else break;
    }
    const intEnd = j;
    let isFloat = false;
    if (j < n && json.charCodeAt(j) === 46 /* dot */) {
      isFloat = true;
      j++;
      while (j < n && json.charCodeAt(j) >= 48 && json.charCodeAt(j) <= 57) j++;
    }
    if (j < n && (json.charCodeAt(j) === 101 || json.charCodeAt(j) === 69) /* e/E */) {
      isFloat = true;
      j++;
      if (j < n && (json.charCodeAt(j) === 43 || json.charCodeAt(j) === 45)) j++;
      while (j < n && json.charCodeAt(j) >= 48 && json.charCodeAt(j) <= 57) j++;
    }
    if (!isFloat && intEnd > intStart) {
      // Integer literal: only rewrite when it exceeds the safe range.
      // Cheap pre-filter on digit count (2^53 has 16 digits).
      const digits = intEnd - intStart;
      if (digits >= 16) {
        const literal = json.slice(i, intEnd);
        const value = BigInt(literal);
        if (value > MAX_SAFE || value < MIN_SAFE) {
          if (out === null) out = [];
          out.push(json.slice(copiedTo, i), '"', literal, '"');
          copiedTo = intEnd;
        }
      }
    }
    i = j > i ? j : i + 1;
  }

  if (out === null) return json;
  out.push(json.slice(copiedTo));
  return out.join("");
}

/** Format an I64 for display without losing precision. */
export function i64ToString(v: I64): string {
  return typeof v === "number" ? String(v) : v;
}

/** Convert an I64 to a number for math where precision loss is acceptable
 * (chart scales, percentages); exact display should use i64ToString. */
export function i64ToNumber(v: I64): number {
  return typeof v === "number" ? v : Number(v);
}

/** Compare two I64 values numerically and exactly. */
export function i64Compare(a: I64, b: I64): number {
  const ba = typeof a === "number" ? BigInt(Math.trunc(a)) : BigInt(a);
  const bb = typeof b === "number" ? BigInt(Math.trunc(b)) : BigInt(b);
  return ba < bb ? -1 : ba > bb ? 1 : 0;
}
