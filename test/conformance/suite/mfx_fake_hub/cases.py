"""Cases: what a caller does through an SDK, what the fake hub expects to receive, and what it
answers. The JSON shape is described in ``case.schema.json`` at the root of the suite."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Step:
    """One request the SDK must send, and the answer the fake hub gives it."""

    #: What the request must be: method, path, query, headers, body, signed.
    expect: dict[str, Any]
    #: What the fake hub answers: status, headers and body, or ``drop`` to close the connection.
    answer: dict[str, Any]
    #: How many requests this step takes in a row; ``"any"`` takes every request that matches.
    times: int | str = 1


@dataclass(frozen=True)
class Case:
    """One rule, as data."""

    id: str
    rule: str
    call: dict[str, Any]
    observe: dict[str, Any]
    server: tuple[Step, ...] = field(default_factory=tuple)
    #: The stream script: one list of steps per WebSocket connection, in the order they open.
    stream: tuple[list[dict[str, Any]], ...] = field(default_factory=tuple)
    #: The contract section the rule comes from, by its heading.
    source: str = ""
    #: The case as written, fixtures expanded: what a runner is handed.
    raw: dict[str, Any] = field(default_factory=dict, compare=False)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Case:
        """Read a case from its JSON form; a missing required field raises ``KeyError``."""
        steps = tuple(
            Step(expect=s["expect"], answer=s.get("answer", {}), times=s.get("times", 1))
            for s in raw.get("server", [])
        )
        return cls(
            id=raw["id"],
            rule=raw["rule"],
            call=raw["call"],
            observe=raw["observe"],
            server=steps,
            stream=tuple(raw.get("stream", [])),
            source=raw.get("source", ""),
            raw=raw,
        )


def expand(value: Any, fixtures: dict[str, Any]) -> Any:  # noqa: ANN401 - any JSON value
    """``value`` with every ``{"$fixture": name, ...}`` replaced by that fixture, the other keys
    of the object laid over it. A fixture saves repeating a whole API object in every case."""
    if isinstance(value, list):
        return [expand(item, fixtures) for item in value]
    if not isinstance(value, dict):
        return value
    if "$fixture" in value:
        base = dict(fixtures[value["$fixture"]])
        base.update({k: expand(v, fixtures) for k, v in value.items() if k != "$fixture"})
        return base
    return {key: expand(item, fixtures) for key, item in value.items()}


def load_cases(directory: Path, fixtures: Path | None = None) -> dict[str, Case]:
    """Every case in every ``*.json`` file under ``directory``, by id. A file holds a list of cases.

    ``fixtures`` (default: ``fixtures.json`` beside ``directory``) names the API objects cases
    refer to with ``$fixture``. Ids are unique across the suite: a duplicate raises ``ValueError``
    naming both files.
    """
    fixtures = fixtures or directory.parent / "fixtures.json"
    named = json.loads(fixtures.read_text(encoding="utf-8")) if fixtures.is_file() else {}
    found: dict[str, Case] = {}
    where: dict[str, Path] = {}
    for path in sorted(directory.rglob("*.json")):
        raw = expand(json.loads(path.read_text(encoding="utf-8")), named)
        for item in raw if isinstance(raw, list) else [raw]:
            case = Case.from_dict(item)
            if case.id in found:
                raise ValueError(f"case {case.id} is in both {where[case.id]} and {path}")
            found[case.id], where[case.id] = case, path
    return found
