// A scripted network for the unit tests: each request gets the next answer, and every request
// is kept for the test to inspect.

export const SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
export const BASE = "https://api.dev.mfxhub.com/v1/";

export type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

export function fake(...handlers: Handler[]) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const queue = [...handlers];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("no answer scripted");
    return Promise.resolve(next(url, init ?? {}));
  };
  return { calls, fetch: impl };
}

export const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
export const error = (status: number, code: string, headers: Record<string, string> = {}) =>
  json(status, { error: { code, message: `refused: ${code}`, details: { field: "x" } } }, headers);
