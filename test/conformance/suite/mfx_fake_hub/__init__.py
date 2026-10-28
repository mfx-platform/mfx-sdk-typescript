"""A fake MFX Hub that plays back one conformance case at a time, on localhost.

An SDK's conformance runner starts it, loads a case by id, makes the case's call through the SDK
against it, and then asks it whether every request the case expected arrived, signed and shaped
as the case says. The fake holds no rules of its own: every expectation comes from the case.

    python -m mfx_fake_hub --cases <directory> [--port 0]

prints ``listening http://127.0.0.1:<port>/v1`` once it is ready.
"""

from mfx_fake_hub.cases import Case, Step, load_cases
from mfx_fake_hub.keys import TEST_KEY_ID, TEST_PUBLIC_KEY, TEST_SEED_HEX
from mfx_fake_hub.server import Hub, make_app

__version__ = "0.3.0"

__all__ = [
    "TEST_KEY_ID",
    "TEST_PUBLIC_KEY",
    "TEST_SEED_HEX",
    "Case",
    "Hub",
    "Step",
    "__version__",
    "load_cases",
    "make_app",
]
