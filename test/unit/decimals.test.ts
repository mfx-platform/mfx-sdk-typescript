import { describe, expect, it } from "vitest";

import { decimal, decimalOut } from "../../src/decimals.js";

describe("prices and volumes are sent as plain decimal strings and a number is refused", () => {
  it.each([
    ["0.01", "0.01"],
    ["1", "1"],
    ["1.", "1"],
    [".5", "0.5"],
    ["+2.5", "2.5"],
    ["007.10", "7.10"],
    ["00", "0"],
    ["1E+3", "1000"],
    ["1e3", "1000"],
    ["1.25E1", "12.5"],
    ["1.5e-3", "0.0015"],
    ["15e-1", "1.5"],
    ["0.0000001", "0.0000001"],
    ["1E-7", "0.0000001"],
    [" 0.10 ", "0.10"],
  ])("writes %j as plain digits, %j, keeping every digit", (given, sent) => {
    expect(decimal("volume", given)).toBe(sent);
    expect(sent).toMatch(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
  });

  it("refuses a number, saying why and what to pass instead", () => {
    expect(() => decimal("volume", 0.07 * 3)).toThrow(TypeError);
    expect(() => decimal("volume", 0.07 * 3)).toThrow(/decimal string, not a number/);
  });

  it("refuses anything else that is not a string", () => {
    expect(() => decimal("price", null)).toThrow(TypeError);
    expect(() => decimal("price", 10n)).toThrow(TypeError);
  });

  it.each(["", ".", "-1", "1.2.3", "abc", "1e", "NaN", "Infinity", "e5"])(
    "refuses %j, which is not a non-negative decimal",
    (given) => {
      expect(() => decimal("volume", given)).toThrow(RangeError);
    },
  );

  it("refuses an exponent no price or volume needs, rather than building a huge string", () => {
    expect(() => decimal("volume", "1e101")).toThrow(RangeError);
    expect(() => decimal("volume", "1e-101")).toThrow(RangeError);
    expect(decimal("volume", "1e2")).toBe("100");
  });
});

describe("a decimal the API sends is kept as its string", () => {
  it("keeps a decimal the API sent as its string, and reads anything else as absent", () => {
    expect(decimalOut("1.12129")).toBe("1.12129");
    expect(decimalOut("")).toBeNull();
    expect(decimalOut(1.1)).toBeNull();
    expect(decimalOut(null)).toBeNull();
  });
});
