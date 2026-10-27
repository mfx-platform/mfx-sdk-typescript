"""The fake hub's HTTP side: a control endpoint to load a case and read the verdict, and every other
path played back from the loaded case's steps.

Control (not part of the MFX Hub API, and never signed):

* ``GET /_hub/cases`` lists every case id, in order.
* ``POST /_hub/case`` with ``{"id": "<case id>"}`` loads a case, forgets the last one, and answers
  the case itself with its fixtures expanded: a runner reads the call and what to observe from it
  and never parses the suite's files.
* ``GET /_hub/verdict`` answers ``{"ok": bool, "problems": [...], "requests": n}``: ``ok`` only
  when every step was satisfied, in order, and nothing else arrived.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Final

from aiohttp import web
from cryptography.exceptions import InvalidSignature

from mfx_fake_hub.cases import Case, Step
from mfx_fake_hub.keys import TEST_KEY_ID, TEST_PUBLIC_KEY

#: What a signed request carries; the names are the API description's.
SIGNED_HEADERS: Final = ("X-MFX-Key", "X-MFX-Timestamp", "X-MFX-Nonce", "X-MFX-Signature")
#: How far a request's timestamp may be from the fake hub's clock, as on the real one.
CLOCK_SKEW_MS: Final = 30_000
NONCE: Final = re.compile(r"[A-Za-z0-9_-]{16,64}")


def signing_message(
    timestamp: str, nonce: str, method: str, path_with_query: str, body: bytes
) -> bytes:
    """The bytes a request's signature covers, as the API description defines them."""
    digest = hashlib.sha256(body).hexdigest()
    return "\n".join((timestamp, nonce, method.upper(), path_with_query, digest)).encode()


def signature_problems(
    headers: Any,
    method: str,
    path_with_query: str,
    body: bytes,
    seen: set[str],
    now_ms: int,  # noqa: ANN401
) -> list[str]:
    """Why a request is not signed by the test key as the API requires; empty when it is."""
    missing = [name for name in SIGNED_HEADERS if not headers.get(name)]
    if missing:
        return [f"not signed: missing {', '.join(missing)}"]
    out: list[str] = []
    if headers["X-MFX-Key"] != TEST_KEY_ID:
        out.append(f"signed with key {headers['X-MFX-Key']!r}, not the test key {TEST_KEY_ID!r}")
    timestamp, nonce = headers["X-MFX-Timestamp"], headers["X-MFX-Nonce"]
    if not timestamp.isdigit() or abs(int(timestamp) - now_ms) > CLOCK_SKEW_MS:
        out.append(f"timestamp {timestamp!r} is not epoch milliseconds within 30 s of now")
    if not NONCE.fullmatch(nonce):
        out.append(f"nonce {nonce!r} is not 16-64 characters of A-Z a-z 0-9 _ -")
    elif nonce in seen:
        out.append(f"nonce {nonce!r} was used before: a retry must be signed again")
    seen.add(nonce)
    try:
        raw = base64.b64decode(headers["X-MFX-Signature"], validate=True)
        TEST_PUBLIC_KEY.verify(
            raw, signing_message(timestamp, nonce, method, path_with_query, body)
        )
    except (binascii.Error, ValueError, InvalidSignature):
        out.append(
            "the signature does not verify over timestamp, nonce, method, path and body hash"
        )
    return out


def request_problems(
    expect: dict[str, Any], method: str, path: str, query: dict[str, str], headers: Any, body: bytes
) -> list[str]:  # noqa: ANN401
    """How a request differs from what a step expects; empty when it matches."""
    out: list[str] = []
    if method != expect.get("method", method):
        out.append(f"method {method}, expected {expect['method']}")
    if path != expect.get("path", path):
        out.append(f"path {path}, expected {expect['path']}")
    if "query" in expect and query != {k: str(v) for k, v in expect["query"].items()}:
        out.append(f"query {query}, expected {expect['query']}")
    for name, want in expect.get("headers", {}).items():
        got = headers.get(name)
        if want is None and got is not None:
            out.append(f"header {name} sent, expected none")
        elif want == "*" and got is None:
            out.append(f"header {name} missing")
        elif want not in ("*", None) and got != want:
            out.append(f"header {name} is {got!r}, expected {want!r}")
    if "json" in expect or "json_contains" in expect:
        try:
            sent = json.loads(body) if body else None
        except ValueError:
            return [*out, f"body is not JSON: {body[:80]!r}"]
        if "json" in expect and sent != expect["json"]:
            out.append(f"body {sent}, expected {expect['json']}")
        for key, want in expect.get("json_contains", {}).items():
            if not isinstance(sent, dict) or key not in sent:
                out.append(f"body has no {key!r}, expected {want!r}")
            elif sent[key] != want or type(sent[key]) is not type(want):
                out.append(f"body {key} is {sent[key]!r}, expected {want!r}")
    return out


@dataclass
class StreamProgress:
    """How far each scripted stream connection got."""

    opened: int = 0
    #: Steps completed, per connection opened.
    done: list[int] = field(default_factory=list)


@dataclass
class Hub:
    """The loaded case and what has happened to it."""

    cases: dict[str, Case]
    case: Case | None = None
    step: int = 0
    taken: int = 0
    requests: int = 0
    problems: list[str] = field(default_factory=list)
    nonces: set[str] = field(default_factory=set)
    stream: StreamProgress = field(default_factory=StreamProgress)

    def load(self, case_id: str) -> None:
        """Load a case by id and forget everything about the last one."""
        self.case = self.cases[case_id]
        self.step = self.taken = self.requests = 0
        self.problems = []
        self.nonces = set()
        self.stream = StreamProgress()

    def _current(self) -> Step | None:
        assert self.case is not None
        return self.case.server[self.step] if self.step < len(self.case.server) else None

    def take(
        self,
        method: str,
        path: str,
        query: dict[str, str],
        headers: Any,
        body: bytes,
        path_with_query: str,
        now_ms: int,
    ) -> dict[str, Any]:  # noqa: ANN401
        """Match one request to the case's next step; return the answer to give."""
        self.requests += 1
        if self.case is None:
            self.problems.append(f"{method} {path} arrived with no case loaded")
            return {
                "status": 500,
                "body": {"error": {"code": "internal_error", "message": "no case"}},
            }
        step = self._current()
        # A step taking any number of requests gives way to the next when it stops matching.
        if (
            step is not None
            and step.times == "any"
            and self.taken > 0
            and request_problems(step.expect, method, path, query, headers, body)
        ):
            self.step, self.taken = self.step + 1, 0
            step = self._current()
        if step is None:
            self.problems.append(
                f"unexpected request {method} {path_with_query}: the case expects no more"
            )
            return {
                "status": 500,
                "body": {
                    "error": {
                        "code": "internal_error",
                        "message": "the fake hub expected no request here",
                    }
                },
            }
        where = f"step {self.step + 1} ({method} {path})"
        self.problems += [
            f"{where}: {p}"
            for p in request_problems(step.expect, method, path, query, headers, body)
        ]
        if step.expect.get("signed", True):
            self.problems += [
                f"{where}: {p}"
                for p in signature_problems(
                    headers, method, path_with_query, body, self.nonces, now_ms
                )
            ]
        self.taken += 1
        if step.times != "any" and self.taken >= int(step.times):
            self.step, self.taken = self.step + 1, 0
        return step.answer

    def verdict(self) -> dict[str, Any]:
        """Whether every step was satisfied in order and nothing else arrived."""
        from mfx_fake_hub.stream import stream_problems  # noqa: PLC0415 - the two import each other

        problems = list(self.problems) + stream_problems(self)
        if self.case is not None:
            for index, step in enumerate(self.case.server[self.step :], start=self.step):
                if step.times == "any" and index == self.step and self.taken > 0:
                    continue
                what = f"{step.expect.get('method')} {step.expect.get('path')}"
                problems.append(f"step {index + 1} ({what}) never arrived")
        return {"ok": not problems, "problems": problems, "requests": self.requests}


def make_app(hub: Hub) -> web.Application:
    """The aiohttp application serving ``hub``."""

    async def load(request: web.Request) -> web.Response:
        wanted = (await request.json()).get("id", "")
        if wanted not in hub.cases:
            return web.json_response({"error": f"no case {wanted!r}"}, status=404)
        hub.load(wanted)
        return web.json_response(hub.cases[wanted].raw)

    async def listing(_: web.Request) -> web.Response:
        return web.json_response(sorted(hub.cases))

    async def verdict(_: web.Request) -> web.Response:
        return web.json_response(hub.verdict())

    async def play(request: web.Request) -> web.StreamResponse:
        body = await request.read()
        answer = hub.take(
            request.method,
            request.path,
            dict(request.query),
            request.headers,
            body,
            request.raw_path,
            int(time.time() * 1000),
        )
        if answer.get("delay_s"):
            await asyncio.sleep(float(answer["delay_s"]))
        if answer.get("drop"):
            if request.transport is not None:
                request.transport.close()
            raise web.HTTPInternalServerError  # never reaches the client: the connection is gone
        payload = answer.get("body")
        return web.Response(
            status=int(answer.get("status", 200)),
            headers=answer.get("headers", {}),
            text=None if payload is None else json.dumps(payload),
            content_type=None if payload is None else "application/json",
        )

    from mfx_fake_hub.stream import play_stream  # noqa: PLC0415 - the two import each other

    async def stream(request: web.Request) -> web.WebSocketResponse:
        return await play_stream(hub, request)

    app = web.Application()
    app.router.add_get("/v1/stream", stream)
    app.router.add_get("/_hub/cases", listing)
    app.router.add_post("/_hub/case", load)
    app.router.add_get("/_hub/verdict", verdict)
    app.router.add_route("*", "/{tail:.*}", play)
    return app
