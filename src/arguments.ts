// Checks on what a caller passes, made before anything is sent. A refused argument is a TypeError
// (the wrong kind of value) or a RangeError (the right kind, out of range), never a request.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id the API names as a uuid. Returned lower-case, as the API writes ids. */
export function uuid(name: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} is a uuid string; got ${typeof value}`);
  }
  if (!UUID.test(value)) throw new RangeError(`${name} is not a uuid: ${JSON.stringify(value)}`);
  return value.toLowerCase();
}

/**
 * The idempotency key every write takes. It has no default: a default would be a value nobody
 * chose, and the point of the key is that the caller can send the same one again and get the same
 * answer back instead of a second order or terminal.
 */
export function idempotencyKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(`idempotencyKey is required on every write; got ${typeof value}`);
  }
  if (value.trim() === "" || value.length > 128) {
    throw new RangeError("idempotencyKey is 1 to 128 characters");
  }
  return value;
}

/** A page size, when one is given: 1 to 200, as the API takes. */
export function limit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(
      `limit is a whole number; got ${typeof value === "number" ? value : typeof value}`,
    );
  }
  if (value < 1 || value > 200) throw new RangeError(`limit is 1 to 200; got ${value}`);
  return value;
}
