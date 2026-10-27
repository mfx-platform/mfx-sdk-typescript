"""The test key every case is signed with: the one in the API description's signing test vector.

It is public by design. Its private half is the 32 bytes ``00`` to ``1f``, so anyone can reproduce
the published signature, and nothing it signs is accepted by a real MFX Hub.
"""

from __future__ import annotations

from typing import Final

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

#: The key id a runner gives its client. A real key id has the same shape.
TEST_KEY_ID: Final = "mfxk_C0NF0RMANCE1"
#: The private key's 32 bytes, as hex: 00 01 02 ... 1f.
TEST_SEED_HEX: Final = bytes(range(32)).hex()
TEST_PUBLIC_KEY: Final[Ed25519PublicKey] = Ed25519PrivateKey.from_private_bytes(
    bytes(range(32))
).public_key()
