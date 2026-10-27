// Prices, volumes and money are decimal strings, in and out.
//
// A JavaScript `number` is a binary float: 0.07 * 3 is 0.21000000000000002, and position sizing is
// arithmetic, so a computed volume is the ordinary case. Taking a number would put that error on
// the wire. So a number is refused before anything is sent, with a message that says what to pass.

const DECIMAL = /^\+?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
/** No price or volume needs more; a larger exponent would only build a huge string. */
const MAX_EXPONENT = 100;

/**
 * One non-negative decimal as the contract writes it: plain digits, no sign, no exponent, no
 * leading zeros (`1E+3` is `"1000"`, `1.5e-3` is `"0.0015"`). Digits are never rounded or dropped.
 *
 * @param name the argument's name, for the message
 * @param value a decimal string, such as `"0.01"`
 */
export function decimal(name: string, value: unknown): string {
  if (typeof value === "number") {
    throw new TypeError(
      `${name} is a decimal string, not a number: a computed number carries binary error ` +
        `(0.07 * 3 is 0.21000000000000002), and MFX Hub takes decimals as strings so nothing is ` +
        `lost. Pass "${String(value)}" only if that is exactly the value you mean.`,
    );
  }
  if (typeof value !== "string") {
    throw new TypeError(`${name} is a decimal string; got ${typeof value}`);
  }
  const match = DECIMAL.exec(value.trim());
  const whole = match?.[1] ?? "";
  const fraction = match?.[2] ?? "";
  if (match === null || whole + fraction === "") {
    throw new RangeError(`${name} is not a non-negative decimal: ${JSON.stringify(value)}`);
  }
  const exponent = Number(match[3] ?? "0");
  if (Math.abs(exponent) > MAX_EXPONENT) {
    throw new RangeError(`${name} has an exponent beyond ±${MAX_EXPONENT}: ${value}`);
  }
  const digits = whole + fraction;
  // Where the decimal point falls in `digits` once the exponent is applied.
  const point = whole.length + exponent;
  const padded =
    point <= 0
      ? "0".repeat(1 - point) + digits
      : point > digits.length
        ? digits + "0".repeat(point - digits.length)
        : digits;
  const at = point <= 0 ? 1 : point;
  const intPart = padded.slice(0, at).replace(/^0+(?=\d)/, "");
  const fracPart = padded.slice(at);
  return fracPart === "" ? intPart : `${intPart}.${fracPart}`;
}

/** A decimal the API sent, kept as its string; anything else reads as absent. */
export function decimalOut(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
