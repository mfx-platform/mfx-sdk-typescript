"""Run the fake hub: ``python -m mfx_fake_hub --cases <directory> [--port 0]``.

Port 0 picks a free port. Once it is listening it prints ``listening http://127.0.0.1:<port>/v1``
on one line, which is what a runner waits for, and serves until it is stopped.
"""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from aiohttp import web

from mfx_fake_hub.cases import load_cases
from mfx_fake_hub.server import Hub, make_app


async def serve(cases: Path, port: int) -> None:
    """Listen on localhost only and print the base URL a client should use."""
    runner = web.AppRunner(make_app(Hub(load_cases(cases))))
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    bound = runner.addresses[0][1]  # the port the system chose when 0 was asked for
    print(f"listening http://127.0.0.1:{bound}/v1", flush=True)  # noqa: T201 - the runner reads it
    await asyncio.Event().wait()


def main() -> None:  # pragma: no cover - a process boundary, exercised by the runners
    """Parse the command line and serve."""
    parser = argparse.ArgumentParser(description="A fake MFX Hub for SDK conformance cases")
    parser.add_argument("--cases", type=Path, required=True, help="the suite's cases directory")
    parser.add_argument("--port", type=int, default=0, help="0 picks a free port")
    args = parser.parse_args()
    asyncio.run(serve(args.cases, args.port))


if __name__ == "__main__":  # pragma: no cover
    main()
