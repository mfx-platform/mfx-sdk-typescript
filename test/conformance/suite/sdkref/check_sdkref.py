"""Check an SDK's ``docs/sdkref.json`` against format ``mfx-sdkref/1``.

    python <suite>/sdkref/check_sdkref.py [--spec <openapi.yaml>] docs/sdkref.json

Standard library only, so an SDK in any language can run it in CI with the Python it already has
for the fake hub. It reads ``sdkref.schema.json`` and ``pages.json`` from its own folder, which is
why an SDK vendors the whole ``sdkref`` folder with the cases. A type's ``schema`` is checked
against the API description's ``components.schemas``: ``--spec`` names the description, and
without it the suite's own ``spec/openapi.yaml`` beside the ``sdkref`` folder is read; when there
is neither, the names are not checked and the command says so on stderr. Exit 0 when the file is
clean, 1 with one line per problem when it is not, 2 when it cannot be read at all.

What it checks, beyond the schema:

* the pages are in the page list's order, each at most once;
* every anchor is unique, starts with its page id, and a member's starts with its type's;
* every ``[Name](#anchor)`` in doc text names an anchor in the file, and no other markup is left
  over from the language's own doc tool;
* no raw HTML in doc text: anything with ``<`` or ``>`` goes in a code span;
* no signature and no parameter default is elided with ``...``;
* every type's ``schema`` is a schema name the API description has, case kept;
* no internal word anywhere in the file;
* the bytes are exactly the canonical form: UTF-8 without a byte order mark, two-space indent,
  ``": "`` after a key, non-ASCII written as itself, LF line ends and one LF at the end - what
  ``json.dumps(data, indent=2, ensure_ascii=False) + "\\n"`` and ``JSON.stringify(data, null, 2)
  + "\\n"`` both write.

The schema is checked by a small validator for exactly the keywords the schema uses; a keyword it
does not know is an error in the schema, never silently passed.
"""

from __future__ import annotations

import functools
import json
import re
import sys
from collections.abc import Collection, Iterator
from pathlib import Path
from typing import Any, Final

HERE: Final = Path(__file__).resolve().parent
SCHEMA_FILE: Final = HERE / "sdkref.schema.json"
PAGES_FILE: Final = HERE / "pages.json"
#: The suite's API description, when the suite is checked out or vendored with its ``spec`` folder.
SPEC_FILE: Final = HERE.parent / "spec" / "openapi.yaml"

#: Words that must never reach a published reference, each with what it is called in a problem.
#: MT5 is matched as the upper-case word that prose uses; the contract's own lower-case names (a
#: venue value or a field such as a retcode's) are the public API's and stay.
FORBIDDEN: Final = (
    ("a work item id", re.compile(r"AB#", re.IGNORECASE)),
    ("a decision id", re.compile(r"\bDEC-", re.IGNORECASE)),
    ("MT5 (write: the terminal)", re.compile(r"\bMT5\b")),
    ("cell", re.compile(r"\bcells?\b", re.IGNORECASE)),
    ("an internal repository name", re.compile(r"-intern[a]l\b", re.IGNORECASE)),
)
#: The keys whose value is Markdown.
MARKDOWN_KEYS: Final = frozenset({"intro", "doc", "deprecated"})

_FENCE: Final = re.compile(r"^ {0,3}(`{3,}|~{3,}).*?^ {0,3}\1[ \t]*$", re.MULTILINE | re.DOTALL)
_CODE_SPAN: Final = re.compile(r"(`+)(?!`).*?(?<!`)\1(?!`)", re.DOTALL)
_LINK: Final = re.compile(r"\[([^\[\]]*)\]\(([^()]*)\)")
_LEFTOVER: Final = (
    ("a reference-style link", re.compile(r"\]\[")),
    ("doc-tool markup such as {@link}", re.compile(r"\{@")),
)
_ELIDED: Final = re.compile(r"\.\.\.\s*(?:[)\]},>]|$)|…")
# Python's typing ellipsis is part of the type, not an elision: tuple[X, ...] and Callable[..., R].
_TYPING_ELLIPSIS: Final = re.compile(r",\s*\.\.\.\s*(?=\])|(?<=\[)\s*\.\.\.\s*(?=,)")

# A key of components.schemas: four spaces in, under "  schemas:", bare or quoted.
_SCHEMA_KEY: Final = re.compile(r"""^ {4}(['"]?)([A-Za-z0-9_.-]+)\1:(?:\s|$)""")

_ANNOTATIONS: Final = frozenset({"$schema", "$id", "$comment", "title", "description", "$defs"})
_TYPES: Final[dict[str, type]] = {"object": dict, "array": list, "string": str}


class SchemaError(Exception):
    """The schema uses a keyword this validator does not implement."""


def _resolve(root: dict[str, Any], ref: str) -> dict[str, Any]:
    if not ref.startswith("#/"):
        raise SchemaError(f"only local references are supported, not {ref}")
    node: Any = root
    for part in ref[2:].split("/"):
        node = node[part]
    return dict(node)


def _validate(
    value: Any, schema: dict[str, Any], root: dict[str, Any], where: str, out: list[str]
) -> None:
    for key, rule in schema.items():
        if key in _ANNOTATIONS or key in ("then", "else"):
            continue
        if key == "$ref":
            _validate(value, _resolve(root, rule), root, where, out)
        elif key == "type":
            if not isinstance(value, _TYPES[rule]):
                out.append(f"{where}: must be a JSON {rule}")
        elif key == "const":
            if value != rule:
                out.append(f"{where}: must be {json.dumps(rule)}")
        elif key == "enum":
            if value not in rule:
                out.append(f"{where}: {json.dumps(value)} is not one of {json.dumps(rule)}")
        elif key == "required":
            if isinstance(value, dict):
                out.extend(f"{where}: {name} is required" for name in rule if name not in value)
        elif key == "properties":
            if isinstance(value, dict):
                for name, sub in rule.items():
                    if name in value:
                        _validate(value[name], sub, root, f"{where}.{name}", out)
        elif key == "additionalProperties":
            if rule is not False:
                raise SchemaError("additionalProperties is supported as false only")
            if isinstance(value, dict):
                known = schema.get("properties", {})
                out.extend(f"{where}: {name} is not allowed" for name in value if name not in known)
        elif key == "minProperties":
            if isinstance(value, dict) and len(value) < rule:
                out.append(f"{where}: must not be empty (omit it instead)")
        elif key == "items":
            if isinstance(value, list):
                for index, item in enumerate(value):
                    _validate(item, rule, root, f"{where}[{index}]", out)
        elif key == "minItems":
            if isinstance(value, list) and len(value) < rule:
                out.append(f"{where}: must not be empty (omit it instead)")
        elif key == "minLength":
            if isinstance(value, str) and len(value) < rule:
                out.append(f"{where}: must not be empty")
        elif key == "pattern":
            if isinstance(value, str) and not re.search(rule, value):
                out.append(f"{where}: {json.dumps(value)} does not match {rule}")
        elif key == "allOf":
            for sub in rule:
                _validate(value, sub, root, where, out)
        elif key == "if":
            branch = schema.get("else" if _errors(value, rule, root) else "then")
            if branch is not None:
                _validate(value, branch, root, where, out)
        elif key == "not":
            if not _errors(value, rule, root):
                out.append(f"{where}: must not match {json.dumps(rule)}")
        else:
            raise SchemaError(f"unsupported keyword {key}")


def _errors(value: Any, schema: dict[str, Any], root: dict[str, Any]) -> list[str]:
    out: list[str] = []
    _validate(value, schema, root, "$", out)
    return out


def validate(data: Any, schema: dict[str, Any]) -> list[str]:
    """Every way ``data`` breaks ``schema``, as ``$.path: problem``; empty when it conforms."""
    out: list[str] = []
    _validate(data, schema, schema, "$", out)
    return out


def _strings(node: Any, where: str = "$") -> Iterator[tuple[str, str, str]]:
    """Every string in ``node`` as (path, key, value); the key is "" for a list item."""
    if isinstance(node, dict):
        for key, value in node.items():
            if isinstance(value, str):
                yield f"{where}.{key}", key, value
            else:
                yield from _strings(value, f"{where}.{key}")
    elif isinstance(node, list):
        for index, item in enumerate(node):
            if isinstance(item, str):
                yield f"{where}[{index}]", "", item
            else:
                yield from _strings(item, f"{where}[{index}]")


def without_code(markdown: str) -> str:
    """``markdown`` with fenced blocks removed and each code span replaced by ``code``."""
    return _CODE_SPAN.sub("code", _FENCE.sub("", markdown))


def markdown_problems(where: str, markdown: str, anchors: set[str]) -> list[str]:
    """What is wrong with one Markdown value: links, leftover markup and raw HTML."""
    out: list[str] = []
    text = without_code(markdown)
    for name, target in _LINK.findall(text):
        if target.startswith("#"):
            if not name.strip():
                out.append(f"{where}: a cross-reference to {target} has no name")
            if target[1:] not in anchors:
                out.append(f"{where}: [{name}]({target}) names no anchor in this file")
        elif not target.startswith("https://"):
            out.append(
                f"{where}: link to {target!r}: a cross-reference is exactly [Name](#anchor), "
                "anything else is an https:// address"
            )
    for what, pattern in _LEFTOVER:
        if pattern.search(text):
            out.append(f"{where}: {what} is left in; write [Name](#anchor) or a code span")
    if "<" in text or ">" in text:
        out.append(
            f"{where}: raw HTML or an angle bracket outside a code span; put it in backticks"
        )
    return out


def contract_schemas(text: str) -> set[str]:
    """The keys of ``components.schemas`` in an API description written as block YAML.

    A line scan, not a YAML parser, so the checker keeps to the standard library: the description
    is written with two-space indents, so a schema's name is a four-space key under
    ``  schemas:`` under ``components:``.
    """
    names: set[str] = set()
    section = ""
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0:
            section = "components" if line.rstrip() == "components:" else ""
        elif indent == 2 and section:
            section = "schemas" if line.rstrip() == "  schemas:" else "components"
        elif section == "schemas" and (key := _SCHEMA_KEY.match(line)):
            names.add(key.group(2))
    return names


@functools.lru_cache(maxsize=4)
def load_contract(path: Path) -> frozenset[str] | None:
    """The schema names of the API description at ``path``; None when there is no such file."""
    if not path.is_file():
        return None
    return frozenset(contract_schemas(path.read_text(encoding="utf-8")))


def _elided(text: str) -> bool:
    """Whether ``text`` is cut short with an ellipsis; Python's typing ellipsis is not a cut."""
    return bool(_ELIDED.search(_TYPING_ELLIPSIS.sub("", text)))


def structure_problems(
    data: dict[str, Any], page_order: list[str], contract: Collection[str] | None = None
) -> list[str]:
    """Page order, anchors, cross-references, signatures, schema names; ``data`` fits the schema.

    ``contract`` is the API description's schema names; None checks no name.
    """
    out: list[str] = []
    seen_pages: list[str] = []
    anchors: dict[str, str] = {}
    for p, page in enumerate(data["pages"]):
        here = f"$.pages[{p}]"
        if page["id"] in seen_pages:
            out.append(f"{here}.id: page {page['id']} appears twice")
        elif seen_pages and page_order.index(page["id"]) < page_order.index(seen_pages[-1]):
            out.append(
                f"{here}.id: page {page['id']} comes before {seen_pages[-1]} in the page list"
            )
        seen_pages.append(page["id"])
        for t, kind in enumerate(page["types"]):
            at = f"{here}.types[{t}]"
            if contract is not None and "schema" in kind and kind["schema"] not in contract:
                out.append(
                    f"{at}.schema: {kind['schema']} is not a schema in the contract "
                    "(a key of components.schemas, case kept)"
                )
            entries = [(at, kind)] + [
                (f"{at}.members[{m}]", member) for m, member in enumerate(kind.get("members", []))
            ]
            for path, entry in entries:
                anchor = entry["anchor"]
                if anchor in anchors:
                    out.append(f"{path}.anchor: {anchor} is also the anchor of {anchors[anchor]}")
                anchors.setdefault(anchor, path)
                if anchor.split(".")[0] != page["id"]:
                    out.append(
                        f"{path}.anchor: {anchor} does not start with its page, {page['id']}"
                    )
                if entry is not kind and not anchor.startswith(kind["anchor"] + "."):
                    out.append(f"{path}.anchor: {anchor} does not start with {kind['anchor']}.")
    known = set(anchors)
    for path, key, value in _strings(data):
        if key in MARKDOWN_KEYS:
            out.extend(markdown_problems(path, value, known))
        elif key == "signature" and _elided(value):
            out.append(f"{path}: a signature is complete, never elided with ...")
        elif key == "default" and _elided(value):
            out.append(f"{path}: a default is the value itself, never elided with ...")
    return out


def word_problems(data: Any) -> list[str]:
    """Every string in ``data`` that holds an internal word."""
    return [
        f"{path}: contains {what}"
        for path, _, value in _strings(data)
        for what, pattern in FORBIDDEN
        if pattern.search(value)
    ]


def format_problems(raw: bytes, data: Any) -> list[str]:
    """Where ``raw`` first differs from the canonical serialisation of ``data``."""
    canonical = (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    if raw == canonical:
        return []
    got, want = raw.split(b"\n"), canonical.split(b"\n")
    line = next(
        (n for n, (a, b) in enumerate(zip(got, want, strict=False), 1) if a != b),
        min(len(got), len(want)),
    )
    return [
        f"line {line}: not the canonical form (UTF-8, two-space indent, LF, one LF at the end, "
        "non-ASCII as itself); write it with json.dumps(data, indent=2, ensure_ascii=False) + '\\n'"
    ]


def _no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    keys = [key for key, _ in pairs]
    twice = sorted({key for key in keys if keys.count(key) > 1})
    if twice:
        raise ValueError(f"duplicate key {', '.join(twice)}")
    return dict(pairs)


def check_bytes(
    raw: bytes,
    schema: dict[str, Any] | None = None,
    page_order: list[str] | None = None,
    contract: Collection[str] | None = None,
) -> list[str]:
    """Every problem with one reference file's bytes; empty when it is clean.

    ``contract`` is the schema names a type may give; None reads them from :data:`SPEC_FILE`, and
    when that is absent too no name is checked.
    """
    contract = contract if contract is not None else load_contract(SPEC_FILE)
    schema = schema if schema is not None else load(SCHEMA_FILE)
    page_order = page_order if page_order is not None else [p["id"] for p in load(PAGES_FILE)]
    if raw.startswith(b"\xef\xbb\xbf"):
        return ["the file starts with a byte order mark; write UTF-8 without one"]
    try:
        data = json.loads(raw.decode("utf-8"), object_pairs_hook=_no_duplicate_keys)
    except UnicodeDecodeError as error:
        return [f"not UTF-8: {error}"]
    except ValueError as error:
        return [f"not JSON: {error}"]
    out = format_problems(raw, data) + word_problems(data)
    shape = validate(data, schema)
    out.extend(shape)
    if not shape:
        out.extend(structure_problems(data, page_order, contract))
    return out


def load(path: Path) -> Any:
    """A JSON file."""
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    """Check each file named; 0 when all are clean, 1 when not, 2 when one cannot be read."""
    args = sys.argv[1:] if argv is None else argv
    spec = SPEC_FILE
    if args[:1] == ["--spec"]:
        spec, args = (Path(args[1]) if len(args) > 1 else spec), args[2:]
        if args and not spec.is_file():
            sys.stderr.write(f"{spec}: no such file\n")
            return 2
    if not args:
        sys.stderr.write("usage: check_sdkref.py [--spec <openapi.yaml>] <sdkref.json> [...]\n")
        return 2
    contract = load_contract(spec)
    if contract is None:
        sys.stderr.write(
            f"no API description at {spec}: schema names are not checked "
            "(vendor the suite's spec folder beside sdkref, or pass --spec <openapi.yaml>)\n"
        )
    status = 0
    for name in args:
        path = Path(name)
        if not path.is_file():
            sys.stderr.write(f"{name}: no such file\n")
            return 2
        problems = check_bytes(path.read_bytes(), contract=contract)
        for problem in problems:
            sys.stdout.write(f"{name}: {problem}\n")
        if problems:
            status = 1
        else:
            sys.stdout.write(f"{name}: a clean mfx-sdkref/1 file\n")
    return status


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
