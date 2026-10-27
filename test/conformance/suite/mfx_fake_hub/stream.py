"""The fake hub's WebSocket side: ``GET /v1/stream``, played back from the case's ``stream`` script.

A case's ``stream`` is a list of connections, in the order the SDK opens them; each connection is a
list of steps:

* ``{"recv": {...}}`` - the SDK must send a frame holding these fields (others may be present);
* ``{"send": {...}}`` - the hub sends this frame;
* ``{"close": 4009, "reason": "..."}`` - the hub closes the connection with this code.

Every upgrade must be signed as a request is, over ``GET``, its path with its query, and an empty
body. A connection the script does not have, a frame it does not expect, or a step never reached
is a problem in the verdict.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import TYPE_CHECKING, Any, Final

from aiohttp import WSMsgType, web

from mfx_fake_hub.server import signature_problems

if TYPE_CHECKING:
    from mfx_fake_hub.server import Hub

#: How long the hub waits for a frame the script expects before calling it missing.
RECV_TIMEOUT_S: Final = 5.0


def stream_problems(hub: Hub) -> list[str]:
    """What the stream script expected and never saw."""
    if hub.case is None:
        return []
    out: list[str] = []
    for index, steps in enumerate(hub.case.stream):
        if index >= hub.stream.opened:
            out.append(f"stream connection {index + 1} was never opened")
        elif hub.stream.done[index] < len(steps):
            missing = steps[hub.stream.done[index]]
            out.append(
                f"stream connection {index + 1} stopped before step "
                f"{hub.stream.done[index] + 1} ({json.dumps(missing)})"
            )
    return out


def _matches(want: dict[str, Any], got: Any) -> list[str]:  # noqa: ANN401 - a decoded frame
    if not isinstance(got, dict):
        return [f"a frame that is not a JSON object: {got!r}"]
    return [
        f"frame field {key} is {got.get(key)!r}, expected {value!r}"
        for key, value in want.items()
        if got.get(key) != value
    ]


async def play_stream(hub: Hub, request: web.Request) -> web.WebSocketResponse:
    """Serve one stream connection from the loaded case's script."""
    index = hub.stream.opened
    hub.stream.opened += 1
    hub.stream.done.append(0)
    where = f"stream connection {index + 1}"
    hub.problems += [
        f"{where}: {p}"
        for p in signature_problems(
            request.headers, "GET", request.raw_path, b"", hub.nonces, int(time.time() * 1000)
        )
    ]
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    script = hub.case.stream if hub.case is not None else []
    if index >= len(script):
        hub.problems.append(f"{where} was opened, and the case expects no more connections")
        await ws.close(code=1011, message=b"the case expects no more connections")
        return ws
    for number, step in enumerate(script[index], start=1):
        if "recv" in step:
            try:
                message = await asyncio.wait_for(ws.receive(), timeout=RECV_TIMEOUT_S)
            except TimeoutError:
                hub.problems.append(
                    f"{where} step {number}: no frame came; expected {step['recv']}"
                )
                break
            if message.type != WSMsgType.TEXT:
                hub.problems.append(
                    f"{where} step {number}: the connection ended; expected {step['recv']}"
                )
                break
            try:
                frame = json.loads(message.data)
            except ValueError:
                frame = message.data
            hub.problems += [f"{where} step {number}: {p}" for p in _matches(step["recv"], frame)]
        elif "send" in step:
            await ws.send_str(json.dumps(step["send"]))
        elif "close" in step:
            hub.stream.done[index] = number
            await ws.close(code=int(step["close"]), message=str(step.get("reason", "")).encode())
            return ws
        hub.stream.done[index] = number
    # The script is played; anything the SDK sends now was not asked for.
    async for message in ws:
        if message.type == WSMsgType.TEXT:
            hub.problems.append(f"{where}: unexpected frame after the script: {message.data}")
    return ws
