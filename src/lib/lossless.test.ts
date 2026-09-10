import { describe, expect, it } from "vitest";
import { i64Compare, parseLossless, rewriteBigIntegers } from "./lossless";

describe("rewriteBigIntegers", () => {
  it("leaves safe integers and floats untouched", () => {
    const s = '{"a": 42, "b": -7, "c": 1.5e10, "d": 9007199254740991}';
    expect(rewriteBigIntegers(s)).toBe(s);
  });

  it("quotes u64::MAX", () => {
    const s = '{"seq": 18446744073709551615}';
    expect(rewriteBigIntegers(s)).toBe('{"seq": "18446744073709551615"}');
  });

  it("quotes negative i64 below the safe range", () => {
    const s = '{"v": -9223372036854775808}';
    expect(rewriteBigIntegers(s)).toBe('{"v": "-9223372036854775808"}');
  });

  it("never rewrites digits inside strings", () => {
    const s = '{"text": "id 18446744073709551615 stays", "esc": "a\\"18446744073709551615"}';
    expect(rewriteBigIntegers(s)).toBe(s);
  });

  it("handles multiple rewrites and nesting", () => {
    const s = '[18446744073709551615, {"x": [1, 99999999999999999999]}]';
    expect(rewriteBigIntegers(s)).toBe('["18446744073709551615", {"x": [1, "99999999999999999999"]}]');
  });

  it("does not rewrite 16-digit values still inside the safe range", () => {
    const s = '{"v": 1000000000000000}';
    expect(rewriteBigIntegers(s)).toBe(s);
  });

  it("leaves large floats with exponents alone", () => {
    const s = '{"v": 123456789012345678e5}';
    expect(rewriteBigIntegers(s)).toBe(s);
  });
});

describe("parseLossless", () => {
  it("round-trips a payload with big ints as strings", () => {
    const obj = parseLossless('{"seq": 18446744073709551615, "small": 3}') as {
      seq: string;
      small: number;
    };
    expect(obj.seq).toBe("18446744073709551615");
    expect(obj.small).toBe(3);
  });
});

describe("i64Compare", () => {
  it("compares mixed representations exactly", () => {
    expect(i64Compare("18446744073709551615", 5)).toBe(1);
    expect(i64Compare(5, "18446744073709551615")).toBe(-1);
    expect(i64Compare("42", 42)).toBe(0);
  });
});
