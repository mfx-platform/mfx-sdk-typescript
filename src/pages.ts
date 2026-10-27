// Cursor pagination, in one place.
//
// Every list in this API is cursor-paginated, and there is no total, no page number and no offset:
// the API cannot answer those cheaply, so the SDK follows the cursor and never pretends to know
// how many there are.

/** One page, and the cursor for the next. `nextCursor` is null on the last page. */
export class Page<T> implements Iterable<T> {
  /**
   * @param items this page's items
   * @param nextCursor pass it back as `cursor` for the next page; null on the last
   * @param returned how many are in THIS page, when the server says. Not a total.
   */
  constructor(
    readonly items: readonly T[],
    readonly nextCursor: string | null,
    readonly returned: number | null,
  ) {}

  /** How many are in this page. Not a total, and never to be shown as one. */
  get length(): number {
    return this.items.length;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.items[Symbol.iterator]();
  }
}

/** A page body as the API sends it. */
interface PageBody<T> {
  readonly items?: readonly T[] | null;
  readonly next_cursor?: string | null;
  readonly returned?: number | null;
}

/**
 * The page an answer holds. An empty cursor reads as the last page, because an empty string
 * passed back as a cursor would fetch the first page again for ever.
 */
export function pageOf<T>(body: unknown): Page<T> {
  const page = (typeof body === "object" && body !== null ? body : {}) as PageBody<T>;
  const cursor = page.next_cursor;
  return new Page(
    page.items ?? [],
    typeof cursor === "string" && cursor !== "" ? cursor : null,
    typeof page.returned === "number" ? page.returned : null,
  );
}

/** Every item of every page, one request a page, following the cursor until it is null. */
export async function* everyItem<T>(
  read: (cursor: string | undefined) => Promise<Page<T>>,
): AsyncGenerator<T, void, undefined> {
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    yield* page.items;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
}
