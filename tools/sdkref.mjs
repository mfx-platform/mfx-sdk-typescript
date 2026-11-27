// Write the SDK reference, docs/sdkref.json, from the package's public exports.
//
//     node tools/sdkref.mjs           # write docs/sdkref.json
//     node tools/sdkref.mjs --check   # fail when docs/sdkref.json differs from a fresh one
//
// The docs site renders one page per page id from every SDK's docs/sdkref.json (format
// mfx-sdkref/1), with the languages side by side, so the file is generated from the source and
// never written by hand. TypeDoc reads the exports of src/index.ts and their doc comments; this
// turns them into the format's pages, types and members:
//
// - Every reflection goes to the page of the module it is declared in (PAGES below), in source
//   order. The generated contract types (`components`, `operations`, `paths`) are not listed.
// - Doc comments become Markdown: `{@link X}` is `[X](#anchor)` when X is listed and a code span
//   when not; `@param`, `@returns`, `@throws` and `@deprecated` fill their own keys; anything
//   written with `<` or `>` (a generic) is put in a code span.
// - Signatures are one line, in the declaration file's own words, never cut short.
// - `operation`, the contract operation a method calls, comes from tools/sdkref-operations.json;
//   test/unit/sdkref.test.ts calls every method listed there and checks the request it sends.
// - An error class's `code` is the API error code errors.ts maps to it.
// - A type's `schema` is the contract schema it represents, which the docs site links to its
//   object: read from the source for an alias of a generated contract type (SCHEMAS below), and
//   named in HAND_SCHEMAS for a hand-written type that carries exactly one schema.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Application, Converter, LogLevel, ReflectionKind } from "typedoc";
import ts from "typescript";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OUTPUT = "docs/sdkref.json";
export const FORMAT = "mfx-sdkref/1";

/**
 * The pages, in the format's fixed order, each with the modules that are its source and its
 * introduction. A module not listed here is not documented; the test fails on an export from one.
 */
export const PAGES = [
  {
    id: "client",
    files: ["client.ts", "signing.ts", "pages.ts", "version.ts"],
    intro:
      "`MfxClient` is the one object an application makes: it signs every request with the API key's Ed25519 private key and holds a namespace for each part of the API (`client.terminals`, `client.execution`, `client.tradingAccounts` and the rest). A list is read a `Page` at a time, or as an async iterator that follows the cursor.",
  },
  {
    id: "terminals",
    files: ["terminals.ts"],
    intro:
      "`client.terminals` asks for hosted trading terminals, lists them, waits for one to be usable, reads its journal and restarts many at once.",
  },
  {
    id: "execution",
    files: ["execution.ts", "results.ts"],
    intro:
      "`client.execution` places, changes and cancels orders and changes and closes positions on a terminal. Every method resolves to an `ExecutionResult` and never rejects for anything the platform or the network does; only a wrong argument throws, before anything is sent. The idempotency key is required, nothing is retried automatically, and prices and volumes are decimal strings.",
  },
  {
    id: "trading-accounts",
    files: ["trading-accounts.ts"],
    intro:
      "`client.tradingAccounts` reads and trades a trading account on any venue: a terminal's account or a cTrader account, by the account's id. It also connects cTrader accounts through a grant.",
  },
  {
    id: "accounts",
    files: ["accounts.ts", "catalog.ts"],
    intro:
      "`client.accounts` reads the trading account behind a terminal: its figures, open positions, pending orders and closed deals. `client.catalog` reads a broker's catalogues and a symbol's quote.",
  },
  {
    id: "market-data",
    files: ["md.ts"],
    intro:
      "`client.md` subscribes to a cTrader account's spots, which then arrive on the stream, and reads its candles.",
  },
  {
    id: "stream",
    files: ["stream.ts", "events.ts"],
    intro:
      "`await client.stream()` opens the multiplexed WebSocket. Subscribe to channels built with `Channel`, then read events with `for await`. A reconnect resumes what can be resumed and says so about the rest; gaps are counted, not hidden.",
  },
  {
    id: "risk",
    files: ["risk.ts"],
    intro:
      "`client.risk` manages Risk Management: policies and their versions, the accounts they protect, the planner, exit plans, challenges and the activity log.",
  },
  {
    id: "copy",
    files: ["copy.ts"],
    intro:
      "`client.copy` runs Copy Trading: leaders and their signals, followers, groups, closes, stop-outs and the copy log.",
  },
  {
    id: "billing",
    files: ["billing.ts"],
    intro:
      "`client.billing` reads billing (`billing:read`): the standing, profiles, the forecast, prices and invoices.",
  },
  {
    id: "tenant",
    files: ["tenant.ts"],
    intro: "`client.tenant` reads the calling key's organisation: what it must still accept.",
  },
  {
    id: "errors",
    files: ["errors.ts"],
    intro:
      "Every failure a read can raise is an `MfxError`, typed by the platform's error code; the HTTP status decides only when the code is one this version does not know. Execution methods never raise: they return an `ExecutionResult` instead.",
  },
];

/** Exported, but the contract's generated types: documented by the API reference, not here. */
const GENERATED = new Set(["generated/api.ts"]);

/**
 * The hand-written types that carry exactly one contract schema, each with that schema's name as
 * a key of `components.schemas`. An alias of a generated type needs no entry: its schema is read
 * from the source. A client, an error, a helper or a function is never listed.
 */
export const HAND_SCHEMAS = new Map([
  ["Tickets", "CommandTickets"],
  ["BillingAction", "BillingAction"],
  ["PlanChange", "PlanChangeSummary"],
]);

// --- The contract schema an alias stands for ----------------------------------------------------

/**
 * Where a type node leads in the generated contract types. A place is one of: `{ components }`,
 * the generated `components` interface; `{ schemas }`, its `schemas` type; `{ schema, node }`, a
 * type node, with `schema` the name of the `components.schemas` entry it is exactly, or null when
 * it is anything else (one property's inline type, say). Undefined when the node leads nowhere
 * this can follow: a generic, a mapped type, or a type the module writes inline.
 */
function locate(node, checker, depth = 0) {
  if (depth > 32) return undefined;
  if (ts.isParenthesizedTypeNode(node)) return locate(node.type, checker, depth + 1);
  if (ts.isIndexedAccessTypeNode(node)) {
    const index = node.indexType;
    let key;
    if (ts.isLiteralTypeNode(index) && ts.isStringLiteral(index.literal)) key = index.literal.text;
    else if (index.kind === ts.SyntaxKind.NumberKeyword) key = ELEMENT;
    else return undefined;
    return step(locate(node.objectType, checker, depth + 1), key, checker, depth + 1);
  }
  if (!ts.isTypeReferenceNode(node)) return { schema: null, node };
  const args = node.typeArguments ?? [];
  if (node.typeName.getText() === "NonNullable" && args.length === 1) {
    const inner = locate(args[0], checker, depth + 1);
    return inner?.node ? at(nonNull(inner.node), checker, depth + 1) : undefined;
  }
  let symbol = checker.getSymbolAtLocation(node.typeName);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const decl = symbol?.declarations?.[0];
  if (decl === undefined || args.length > 0) return undefined;
  const file = decl.getSourceFile().fileName.replaceAll("\\", "/");
  if (ts.isInterfaceDeclaration(decl) && decl.name.text === "components") {
    return file.endsWith("/generated/api.ts") ? { components: decl } : undefined;
  }
  if (ts.isTypeAliasDeclaration(decl) && !decl.typeParameters) {
    return locate(decl.type, checker, depth + 1);
  }
  return undefined;
}

/** The key of an array's element in a path. */
const ELEMENT = Symbol("element");

/** A node as a place: what it refers to when it is a reference, else the node itself. */
const at = (node, checker, depth) =>
  ts.isTypeReferenceNode(node) || ts.isIndexedAccessTypeNode(node)
    ? locate(node, checker, depth)
    : { schema: null, node };

/** `node` without its `| null` and `| undefined`. */
function nonNull(node) {
  if (!ts.isUnionTypeNode(node)) return node;
  const kept = node.types.filter(
    (t) =>
      !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword) &&
      t.kind !== ts.SyntaxKind.UndefinedKeyword,
  );
  return kept.length === 1 ? kept[0] : node;
}

const propertyOf = (members, key) =>
  members.find((m) => ts.isPropertySignature(m) && m.name.getText() === key);

/** The place `key` (a property's name, or ELEMENT) leads to from the place `from`. */
function step(from, key, checker, depth) {
  if (from === undefined) return undefined;
  if (from.components) {
    const member = key === "schemas" ? propertyOf(from.components.members, key) : undefined;
    return member?.type && ts.isTypeLiteralNode(member.type) ? { schemas: member.type } : undefined;
  }
  if (from.schemas) {
    const member = typeof key === "string" ? propertyOf(from.schemas.members, key) : undefined;
    return member?.type ? { schema: key, node: member.type } : undefined;
  }
  const { node } = from;
  if (key === ELEMENT) {
    return ts.isArrayTypeNode(node) ? at(node.elementType, checker, depth) : undefined;
  }
  const member = ts.isTypeLiteralNode(node) ? propertyOf(node.members, key) : undefined;
  return member?.type ? at(member.type, checker, depth) : undefined;
}

/**
 * The `components.schemas` name an alias's declared type is exactly, followed through other
 * aliases and into the generated types; undefined when it is anything else.
 */
export function schemaOfAlias(decl, checker) {
  return locate(decl.type, checker)?.schema ?? undefined;
}

// --- Types, as the declaration file writes them --------------------------------------------------

const literal = (t) => {
  if (t.value === null) return "null";
  if (typeof t.value === "string") return JSON.stringify(t.value);
  if (typeof t.value === "object") return `${t.value.negative ? "-" : ""}${t.value.value}n`;
  return String(t.value);
};

const typeParams = (list) =>
  list && list.length > 0
    ? `<${list
        .map(
          (p) =>
            `${p.flags?.isConst ? "const " : ""}${p.name}` +
            (p.type ? ` extends ${typeText(p.type)}` : "") +
            (p.default ? ` = ${typeText(p.default)}` : ""),
        )
        .join(", ")}>`
    : "";

// The declaration each reflection came from. A type is written as the source writes it, so that
// an alias such as `Account` stays `Account` rather than the contract's object it stands for;
// TypeDoc's own model is the fallback where the source writes no type (an inferred constant).
const NODES = new WeakMap();
const PRINTER = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

/** The type node `node` writes, printed on one line; undefined when it writes none. */
function printed(node) {
  const typeNode = node?.type;
  if (typeNode === undefined) return undefined;
  return withLocals(oneLine(typeNode), typeNode.getSourceFile());
}

const oneLine = (node) =>
  PRINTER.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
    .replace(/\s*\n\s*/g, " ")
    .replace(/; }/g, " }")
    .replace(/;$/, "");

const LOCALS = new WeakMap();
const LITERALS = new WeakMap();
/** The contract schema each alias reflection is exactly, read from its declaration. */
const SCHEMAS = new WeakMap();

/**
 * The module's own unexported types, by name, as text a reader can follow: an alias as the type
 * it stands for, an interface as its object type. They are written in their place, because a
 * reader cannot look up a name the package does not export.
 */
function localsOf(file) {
  let locals = LOCALS.get(file);
  if (locals !== undefined) return locals;
  locals = new Map();
  for (const st of file.statements) {
    const exported = ts.getCombinedModifierFlags(st) & ts.ModifierFlags.Export;
    if (exported || st.typeParameters?.length) continue;
    if (ts.isTypeAliasDeclaration(st)) locals.set(st.name.text, oneLine(st.type));
    if (ts.isInterfaceDeclaration(st) && !st.heritageClauses) {
      locals.set(st.name.text, `{ ${st.members.map(oneLine).join("; ")} }`);
    }
  }
  LOCALS.set(file, locals);
  return locals;
}

function withLocals(text, file) {
  const locals = localsOf(file);
  let out = text;
  for (let round = 0; round < 5; round++) {
    let changed = false;
    for (const [name, body] of locals) {
      const pattern = new RegExp(String.raw`(?<![\w$."'])${name}(?![\w$"'])`, "g");
      out = out.replace(pattern, () => {
        changed = true;
        return body;
      });
    }
    if (!changed) break;
  }
  return out;
}

/**
 * A default value in full, as the source writes it. TypeDoc shortens a long one to "...", which
 * the format refuses as a value cut short.
 */
function defaultText(reflection, node) {
  if (reflection.defaultValue === undefined) return undefined;
  const init = node?.initializer;
  return init === undefined
    ? ONE_LINE(reflection.defaultValue)
    : withLocals(oneLine(init), init.getSourceFile());
}

/** The text of a reflection's type: its source's, or TypeDoc's when the source writes none. */
const typeOf = (reflection, type, node = NODES.get(reflection)) => printed(node) ?? typeText(type);

/** A base type a reader can look up: listed, or outside the package (`Error`). */
const visibleBase = (t) =>
  t.type !== "reference" || t.reflection !== undefined || t.package !== PACKAGE;
let PACKAGE = "";

const paramText = (p, node) => {
  const rest = p.flags?.isRest ? "..." : "";
  const optional = !rest && (p.flags?.isOptional || p.defaultValue !== undefined) ? "?" : "";
  return `${rest}${p.name}${optional}: ${typeOf(p, p.type, node)}`;
};

const paramNode = (sig, index) => NODES.get(sig)?.parameters?.[index];
const paramsText = (sig) =>
  (sig.parameters ?? []).map((p, i) => paramText(p, paramNode(sig, i))).join(", ");

/** `(a: A, b?: B): R` or, as a function type, `(a: A) => R`. */
const callText = (sig, arrow = false) =>
  `${typeParams(sig.typeParameters)}(${paramsText(sig)})` +
  (arrow ? ` => ${typeOf(sig, sig.type)}` : `: ${typeOf(sig, sig.type)}`);

const propertyText = (child) => {
  const ro = child.flags?.isReadonly ? "readonly " : "";
  const opt = child.flags?.isOptional ? "?" : "";
  if (child.signatures && child.signatures.length > 0 && !child.type) {
    return child.signatures.map((s) => `${child.name}${opt}${callText(s)}`).join("; ");
  }
  if (child.getSignature) {
    return `${ro}${child.name}: ${typeOf(child.getSignature, child.getSignature.type)}`;
  }
  return `${ro}${child.name}${opt}: ${typeOf(child, child.type)}`;
};

function objectText(decl) {
  const parts = [];
  for (const sig of decl.signatures ?? []) {
    if (decl.signatures.length === 1 && !decl.children && !decl.indexSignatures) {
      return callText(sig, true);
    }
    parts.push(callText(sig));
  }
  for (const sig of decl.indexSignatures ?? []) {
    const [key] = sig.parameters ?? [];
    parts.push(
      `${sig.flags?.isReadonly ? "readonly " : ""}[${key?.name ?? "key"}: ${typeText(key?.type)}]: ${typeText(sig.type)}`,
    );
  }
  for (const child of decl.children ?? []) parts.push(propertyText(child));
  return parts.length === 0 ? "{}" : `{ ${parts.join("; ")} }`;
}

// Precedence, loosest first: a type of a looser kind is put in parentheses inside a tighter one.
const LOOSENESS = { function: 4, conditional: 4, union: 3, intersection: 2, typeOperator: 1 };
const loose = (t) =>
  t?.type === "reflection" && t.declaration.signatures?.length === 1 && !t.declaration.children
    ? LOOSENESS.function
    : (LOOSENESS[t?.type] ?? 0);
const wrap = (t, limit) => (loose(t) > limit ? `(${typeText(t)})` : typeText(t));

/** A type as TypeScript writes it, on one line. */
export function typeText(t) {
  if (t === undefined || t === null) return "unknown";
  switch (t.type) {
    case "intrinsic":
    case "unknown":
      return t.name;
    case "literal":
      return literal(t);
    case "reference": {
      const args = t.typeArguments?.length
        ? `<${t.typeArguments.map((a) => typeText(a)).join(", ")}>`
        : "";
      return `${t.name}${args}`;
    }
    case "array":
      return `${wrap(t.elementType, 0)}[]`;
    case "union":
      return t.types.map((u) => wrap(u, 3)).join(" | ");
    case "intersection":
      return t.types.map((u) => wrap(u, 2)).join(" & ");
    case "tuple":
      return `[${(t.elements ?? []).map((e) => typeText(e)).join(", ")}]`;
    case "namedTupleMember":
      return `${t.name}${t.isOptional ? "?" : ""}: ${typeText(t.element)}`;
    case "optional":
      return `${wrap(t.elementType, 0)}?`;
    case "rest":
      return `...${typeText(t.elementType)}`;
    case "typeOperator":
      return `${t.operator} ${wrap(t.target, 1)}`;
    case "query":
      return `typeof ${typeText(t.queryType)}`;
    case "indexedAccess":
      return `${wrap(t.objectType, 0)}[${typeText(t.indexType)}]`;
    case "conditional":
      return (
        `${wrap(t.checkType, 3)} extends ${wrap(t.extendsType, 3)} ? ` +
        `${typeText(t.trueType)} : ${typeText(t.falseType)}`
      );
    case "inferred":
      return `infer ${t.name}${t.constraint ? ` extends ${typeText(t.constraint)}` : ""}`;
    case "predicate":
      return `${t.asserts ? "asserts " : ""}${t.name}${t.targetType ? ` is ${typeText(t.targetType)}` : ""}`;
    case "templateLiteral":
      return (
        "`" + t.head + t.tail.map(([inner, text]) => `\${${typeText(inner)}}${text}`).join("") + "`"
      );
    case "mapped": {
      const ro = t.readonlyModifier ? `${t.readonlyModifier === "-" ? "-" : ""}readonly ` : "";
      const opt = t.optionalModifier ? (t.optionalModifier === "-" ? "-?" : "?") : "";
      const as = t.nameType ? ` as ${typeText(t.nameType)}` : "";
      return `{ ${ro}[${t.parameter} in ${typeText(t.parameterType)}${as}]${opt}: ${typeText(t.templateType)} }`;
    }
    case "reflection":
      return objectText(t.declaration);
    default:
      throw new Error(`sdkref: no text for a ${t.type} type`);
  }
}

// --- Doc comments, as Markdown ---------------------------------------------------------------------

// A generic written in prose, such as Page<Deal> or Promise<void>; put in a code span.
const GENERIC = /[A-Za-z_$][\w$.]*<[^<>\n`]*(?:<[^<>\n`]*>[^<>\n`]*)*>(?:\[\])?/g;

/** `text` with every generic outside a code span put in one. */
export function codeSpanGenerics(text) {
  return text
    .split(/(`[^`]*`)/)
    .map((piece, i) => (i % 2 === 1 ? piece : piece.replace(GENERIC, (g) => `\`${g}\``)))
    .join("");
}

/**
 * Markdown from TypeDoc's comment parts. `anchorOf(reflection)` is the anchor of a listed
 * reflection, or undefined.
 */
export function partsToMarkdown(parts, anchorOf) {
  let out = "";
  for (const part of parts ?? []) {
    if (part.kind === "text") out += codeSpanGenerics(part.text);
    else if (part.kind === "code") out += part.text;
    else if (part.kind === "inline-tag") {
      const name =
        (part.text || "").trim() ||
        (typeof part.target === "object" ? part.target?.name : "") ||
        "";
      if (part.tag === "@link" || part.tag === "@linkcode" || part.tag === "@linkplain") {
        const anchor =
          part.target && typeof part.target === "object" ? anchorOf(part.target) : undefined;
        out += anchor ? `[${name}](#${anchor})` : `\`${name}\``;
      } else {
        out += codeSpanGenerics(name);
      }
    } else out += codeSpanGenerics(part.text ?? "");
  }
  return out.trim();
}

/** The block tags this format has keys for; any other is written into the doc under its name. */
const KEYED = new Set(["@param", "@returns", "@throws", "@deprecated", "@typeParam"]);
const TITLES = { "@remarks": "", "@example": "Example", "@see": "See also" };

function docOf(comment, anchorOf) {
  if (!comment) return "";
  const pieces = [partsToMarkdown(comment.summary, anchorOf)];
  for (const tag of comment.blockTags ?? []) {
    if (KEYED.has(tag.tag)) continue;
    const body = partsToMarkdown(tag.content, anchorOf);
    const title = TITLES[tag.tag] ?? tag.tag.slice(1).replace(/^./, (c) => c.toUpperCase());
    pieces.push(title === "" ? body : `**${title}**\n\n${body}`);
  }
  return pieces.filter((p) => p !== "").join("\n\n");
}

const tagsOf = (comment, name) => (comment?.blockTags ?? []).filter((t) => t.tag === name);

function raisesOf(comment, anchorOf) {
  return tagsOf(comment, "@throws").map((tag) => {
    const [first, ...rest] = tag.content;
    if (first?.kind === "inline-tag") {
      return omitEmpty({ type: first.text.trim(), doc: partsToMarkdown(rest, anchorOf) });
    }
    const text = partsToMarkdown(tag.content, anchorOf);
    const [type, ...words] = text.replace(/^`|`(?=\s)/g, "").split(/\s+/);
    return omitEmpty({ type, doc: words.join(" ") });
  });
}

// --- The model --------------------------------------------------------------------------------------

/**
 * `value` without its empty keys: never null, never [], never "" (the format omits them). `doc`
 * is the exception: the format requires it, and an undocumented entry has it as "".
 */
export function omitEmpty(value) {
  return Object.fromEntries(
    Object.entries(value)
      .map(([k, v]) => [k, k === "doc" && (v === undefined || v === null) ? "" : v])
      .filter(
        ([k, v]) =>
          v !== undefined &&
          v !== null &&
          (v !== "" || k === "doc") &&
          !(Array.isArray(v) && v.length === 0),
      ),
  );
}

const ONE_LINE = (s) => s.replace(/\s*\n\s*/g, " ");

/** The API error code errors.ts maps to each class, read from its BY_CODE table. */
export function errorCodes(errorsSource) {
  const file = ts.createSourceFile("errors.ts", errorsSource, ts.ScriptTarget.Latest, true);
  const codes = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === "BY_CODE" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const p of node.initializer.properties) {
        if (ts.isPropertyAssignment(p)) {
          const key = p.name.getText(file).replace(/^["']|["']$/g, "");
          const cls = p.initializer.getText(file);
          if (codes.has(cls)) throw new Error(`sdkref: ${cls} maps two codes`);
          codes.set(cls, key);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return codes;
}

const isErrorClass = (refl, byName) => {
  const seen = new Set();
  let current = refl;
  while (current && !seen.has(current.name)) {
    seen.add(current.name);
    const base = current.extendedTypes?.[0];
    if (!base) return false;
    if (base.name === "Error") return true;
    current = byName.get(base.name);
  }
  return false;
};

/** The member name as written, and the segment of its anchor. */
const memberName = (child) => {
  const symbol = /^\[(\w+)\]$/.exec(child.name);
  return symbol
    ? { name: `[Symbol.${symbol[1]}]`, segment: symbol[1] }
    : { name: child.name, segment: child.name };
};

// Members a reader never calls: Node's inspection hook; a name only Error's machinery reads.
const SKIPPED_SYMBOLS = new Set(["[custom]"]);

function memberSignature(child, owner) {
  const isStatic = child.flags?.isStatic ? "static " : "";
  const { name } = memberName(child);
  if (child.kindOf(ReflectionKind.Constructor)) {
    return child.signatures.map((s) => `constructor(${paramsText(s)})`);
  }
  if (child.kindOf(ReflectionKind.Method) || (child.signatures?.length && !child.type)) {
    return child.signatures.map((s) => `${isStatic}${name}${callText(s)}`);
  }
  if (child.kindOf(ReflectionKind.Accessor)) {
    const ro = child.setSignature ? "" : "readonly ";
    const type = child.getSignature?.type ?? child.setSignature?.parameters?.[0]?.type;
    const sig = child.getSignature ?? child.setSignature;
    return [`${isStatic}${ro}${name}: ${typeOf(sig, type)}`];
  }
  if (owner === "constant" && child.defaultValue !== undefined && !child.type) {
    return [`${name}: ${defaultText(child, NODES.get(child))}`];
  }
  return [`${isStatic}${propertyText({ ...child, name, flags: child.flags })}`];
}

function memberKind(child, ownerKind) {
  if (child.kindOf(ReflectionKind.Constructor)) return "constructor";
  if (child.kindOf(ReflectionKind.Method) || (child.signatures?.length && !child.type))
    return "method";
  if (child.kindOf(ReflectionKind.EnumMember)) return "value";
  if (ownerKind === "constant" || ownerKind === "enum") return "value";
  if (ownerKind === "class" || ownerKind === "error") return "property";
  return "field";
}

/**
 * What a call takes and gives back, as a method or a free function writes it: its parameters, and
 * (unless `withReturns` is false, as for a constructor) its return type when it is not void.
 */
function callOf(s, comment, withReturns, ctx) {
  const out = {
    params: (s.parameters ?? []).map((p, i) =>
      omitEmpty({
        name: p.flags?.isRest ? `...${p.name}` : p.name,
        type: typeOf(p, p.type, paramNode(s, i)),
        default: defaultText(p, paramNode(s, i)),
        doc: docOf(p.comment, ctx.anchorOf),
      }),
    ),
  };
  const returns = typeOf(s, s.type);
  if (withReturns && returns !== "void") {
    out.returns = omitEmpty({
      type: returns,
      doc: tagsOf(comment, "@returns")
        .map((t) => partsToMarkdown(t.content, ctx.anchorOf))
        .join("\n\n"),
    });
  }
  return out;
}

function buildMember(child, type, ctx) {
  const { segment } = memberName(child);
  const anchor = `${type.anchor}.${segment}`;
  const kind = memberKind(child, type.kind);
  const signatures = memberSignature(child, type.kind);
  const sig = child.signatures?.[0] ?? child.getSignature;
  const comment = sig?.comment ?? child.comment;
  const member = {
    anchor,
    kind,
    name: memberName(child).name,
    signature: ONE_LINE(signatures.join("; ")),
    doc: docOf(comment, ctx.anchorOf),
  };
  if (child.signatures?.length && (kind === "method" || kind === "constructor")) {
    Object.assign(member, callOf(child.signatures[0], comment, kind === "method", ctx));
  }
  member.raises = raisesOf(comment, ctx.anchorOf);
  member.operation = ctx.operations.get(`${type.name}.${child.name}`);
  if (member.operation !== undefined) ctx.usedOperations.add(`${type.name}.${child.name}`);
  member.deprecated = tagsOf(comment, "@deprecated")
    .map((t) => partsToMarkdown(t.content, ctx.anchorOf) || "Deprecated.")
    .join("\n\n");
  return omitEmpty(member);
}

function typeKind(refl, ctx) {
  if (refl.kindOf(ReflectionKind.Class)) return isErrorClass(refl, ctx.byName) ? "error" : "class";
  if (refl.kindOf(ReflectionKind.Interface)) return "interface";
  if (refl.kindOf(ReflectionKind.Enum)) return "enum";
  if (refl.kindOf(ReflectionKind.Function)) return "function";
  if (refl.kindOf(ReflectionKind.Variable)) return "constant";
  if (refl.kindOf(ReflectionKind.TypeAlias)) return "alias";
  throw new Error(`sdkref: ${refl.name} is a ${ReflectionKind[refl.kind]}, which has no kind`);
}

function typeSignature(refl, kind) {
  const tp = typeParams(refl.typeParameters);
  const ext = (refl.extendedTypes ?? []).filter(visibleBase).map(typeText);
  const impl = (refl.implementedTypes ?? []).map(typeText);
  switch (kind) {
    case "class":
    case "error":
      return (
        `${refl.flags?.isAbstract ? "abstract " : ""}class ${refl.name}${tp}` +
        (ext.length ? ` extends ${ext.join(", ")}` : "") +
        (impl.length ? ` implements ${impl.join(", ")}` : "")
      );
    case "interface":
      return `interface ${refl.name}${tp}${ext.length ? ` extends ${ext.join(", ")}` : ""}`;
    case "enum":
      return `enum ${refl.name}`;
    case "function":
      return refl.signatures.map((s) => `function ${refl.name}${callText(s)}`).join("; ");
    case "constant":
      return `const ${refl.name}: ${typeOf(refl, refl.type)}`;
    default:
      return `type ${refl.name}${tp} = ${LITERALS.get(refl) ?? typeOf(refl, refl.type)}`;
  }
}

/** The members a type lists: its own, public, in declaration order. */
function membersOf(refl, kind) {
  let children = refl.children ?? [];
  if (kind === "alias" || kind === "constant") {
    children = refl.type?.type === "reflection" ? (refl.type.declaration.children ?? []) : [];
  }
  return children.filter(
    (c) =>
      // Inherited from a listed type, a member is listed there; from an unexported base, here.
      (!c.inheritedFrom || !visibleBase(c.inheritedFrom)) &&
      !c.flags?.isPrivate &&
      !c.flags?.isProtected &&
      !c.name.startsWith("#") &&
      !SKIPPED_SYMBOLS.has(c.name) &&
      // `override name = "..."` on an error class: Error's own, not this SDK's.
      !(c.overwrites && !c.comment && !c.signatures && !c.getSignature),
  );
}

/**
 * The fields an interface takes from an unexported interface of its module (risk.ts's `Paged`),
 * which TypeDoc leaves out: listed on the interface itself, as a reader meets them.
 */
function unexportedBaseMembers(refl, anchor) {
  const node = NODES.get(refl);
  if (node === undefined || !ts.isInterfaceDeclaration(node)) return [];
  const file = node.getSourceFile();
  const out = [];
  for (const clause of node.heritageClauses ?? []) {
    for (const base of clause.types) {
      const name = base.expression.getText(file);
      const local = file.statements.find(
        (st) =>
          ts.isInterfaceDeclaration(st) &&
          st.name.text === name &&
          !(ts.getCombinedModifierFlags(st) & ts.ModifierFlags.Export),
      );
      for (const m of local?.members ?? []) {
        if (!ts.isPropertySignature(m)) continue;
        const doc = ts
          .getJSDocCommentsAndTags(m)
          .map((d) => (typeof d.comment === "string" ? d.comment : ""))
          .join("\n\n");
        out.push(
          omitEmpty({
            anchor: `${anchor}.${m.name.getText(file)}`,
            kind: "field",
            name: m.name.getText(file),
            signature: withLocals(oneLine(m), file),
            doc: codeSpanGenerics(doc.trim()),
          }),
        );
      }
    }
  }
  return out;
}

function buildType(refl, page, ctx) {
  const kind = typeKind(refl, ctx);
  const anchor = `${page}.${refl.name}`;
  const comment = refl.comment ?? refl.signatures?.[0]?.comment;
  const type = {
    anchor,
    kind,
    name: refl.name,
    signature: ONE_LINE(typeSignature(refl, kind)),
    doc: docOf(comment, ctx.anchorOf),
    extends: (refl.extendedTypes ?? []).filter(visibleBase).map(typeText),
  };
  if (kind === "error") type.code = ctx.codes.get(refl.name);
  // The contract object it is (suite 0.11.0): never a call, an error or a client.
  if (kind === "alias" || kind === "interface") {
    type.schema = ctx.schemas.get(refl.name) ?? SCHEMAS.get(refl);
    if (ctx.schemas.has(refl.name)) ctx.usedSchemas.add(refl.name);
  }
  // A free function is a call, described as a method is (suite 0.10.1): its parameters, what it
  // returns, what it raises and the operation it calls, keyed by its own name in the map.
  if (kind === "function" && refl.signatures?.length) {
    Object.assign(type, callOf(refl.signatures[0], comment, true, ctx));
    type.raises = raisesOf(comment, ctx.anchorOf);
    type.operation = ctx.operations.get(refl.name);
    if (type.operation !== undefined) ctx.usedOperations.add(refl.name);
  }
  const members = membersOf(refl, kind).map((child) =>
    buildMember(child, { anchor, kind, name: refl.name }, ctx),
  );
  type.members = [...unexportedBaseMembers(refl, anchor), ...members];
  return omitEmpty(type);
}

const sourceFile = (refl) => {
  const full = refl.sources?.[0]?.fullFileName ?? refl.sources?.[0]?.fileName ?? "";
  const norm = full.replaceAll("\\", "/");
  const at = norm.lastIndexOf("/src/");
  return at >= 0 ? norm.slice(at + 5) : basename(norm);
};

/** Convert `entry` with TypeDoc; the project reflection. */
export async function convert(entry, tsconfig) {
  const app = await Application.bootstrap({
    // TypeDoc reads entry points as globs, which take forward slashes only.
    entryPoints: [entry.replaceAll("\\", "/")],
    tsconfig,
    logLevel: LogLevel.Error,
    excludePrivate: true,
    excludeProtected: true,
    excludeInternal: true,
    excludeExternals: true,
    disableGit: true,
    sourceLinkTemplate: "{path}",
    sort: ["source-order"],
    readme: "none",
    validation: { notExported: false, invalidLink: false, notDocumented: false },
  });
  app.converter.on(Converter.EVENT_CREATE_DECLARATION, (context, reflection) => {
    const symbol = context.getSymbolFromReflection(reflection);
    const node = symbol?.declarations?.[0];
    if (node !== undefined) NODES.set(reflection, node);
    // An alias that comes down to literals, such as `Side`, is written as them ("buy" | "sell").
    if (symbol !== undefined && reflection.kindOf(ReflectionKind.TypeAlias)) {
      const type = context.checker.getDeclaredTypeOfSymbol(symbol);
      const parts = type.isUnion() ? type.types : [type];
      if (parts.every((t) => t.isLiteral() || (t.flags & ts.TypeFlags.BooleanLiteral) !== 0)) {
        LITERALS.set(reflection, parts.map((t) => context.checker.typeToString(t)).join(" | "));
      }
      if (node !== undefined && ts.isTypeAliasDeclaration(node)) {
        const schema = schemaOfAlias(node, context.checker);
        if (schema !== undefined) SCHEMAS.set(reflection, schema);
      }
    }
  });
  app.converter.on(Converter.EVENT_CREATE_SIGNATURE, (_context, reflection, node) => {
    if (node !== undefined) NODES.set(reflection, node);
  });
  const project = await app.convert();
  if (!project || app.logger.hasErrors())
    throw new Error("sdkref: TypeDoc could not convert the package");
  return project;
}

/**
 * The reference as an object, from a converted project. `operations` maps `Type.member` to an
 * operationId, `codes` an error class to its API code.
 */
export function build(
  project,
  { pages = PAGES, operations = new Map(), codes = new Map(), schemas = HAND_SCHEMAS, head },
) {
  PACKAGE = project.packageName ?? head?.package ?? "";
  const pageOfFile = new Map();
  pages.forEach((p) => p.files.forEach((f) => pageOfFile.set(f, p.id)));
  const listed = (project.children ?? []).filter((r) => !r.kindOf(ReflectionKind.Reference));
  const byName = new Map(listed.map((r) => [r.name, r]));

  const unplaced = listed.filter(
    (r) => !GENERATED.has(sourceFile(r)) && !pageOfFile.has(sourceFile(r)),
  );
  if (unplaced.length > 0) {
    throw new Error(
      `sdkref: no page for ${unplaced.map((r) => `${r.name} (${sourceFile(r)})`).join(", ")}`,
    );
  }

  // Anchors first, so that a link can point forward.
  const anchors = new Map();
  for (const r of listed) {
    const page = pageOfFile.get(sourceFile(r));
    if (page === undefined) continue;
    anchors.set(r, `${page}.${r.name}`);
    const kids =
      r.type?.type === "reflection" ? (r.type.declaration.children ?? []) : (r.children ?? []);
    for (const c of kids) anchors.set(c, `${page}.${r.name}.${memberName(c).segment}`);
    for (const c of r.children ?? [])
      for (const s of c.signatures ?? []) anchors.set(s, anchors.get(c));
  }
  const anchorOf = (target) =>
    anchors.get(target) ??
    (target.parent && target.kindOf?.(ReflectionKind.CallSignature)
      ? anchors.get(target.parent)
      : undefined);

  const ctx = {
    anchorOf,
    operations,
    codes,
    schemas,
    byName,
    usedOperations: new Set(),
    usedSchemas: new Set(),
  };
  const out = [];
  for (const page of pages) {
    const types = [];
    for (const file of page.files) {
      for (const r of listed) if (sourceFile(r) === file) types.push(buildType(r, page.id, ctx));
    }
    if (types.length > 0) out.push({ id: page.id, intro: page.intro, types });
  }
  const unused = [...operations.keys()].filter((k) => !ctx.usedOperations.has(k));
  if (unused.length > 0) throw new Error(`sdkref: no member for ${unused.join(", ")}`);
  const unmapped = [...schemas.keys()].filter((k) => !ctx.usedSchemas.has(k));
  if (unmapped.length > 0) {
    throw new Error(`sdkref: no alias or interface for ${unmapped.join(", ")}`);
  }
  return { ...head, pages: out };
}

/** The file's text: two-space indent, LF, a newline at the end. */
export const serialise = (reference) => JSON.stringify(reference, null, 2) + "\n";

/** The package's head: what it is, which version, how it is installed and where it lives. */
export function headOf(pkg) {
  const source = pkg.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "");
  return {
    format: FORMAT,
    language: "typescript",
    package: pkg.name,
    version: pkg.version,
    install: `npm install ${pkg.name}`,
    links: omitEmpty({ package: `https://www.npmjs.com/package/${pkg.name}`, source }),
  };
}

/** docs/sdkref.json as it should be, from the source in `repo`. */
export async function generate(repo = REPO) {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const operations = new Map(
    Object.entries(JSON.parse(readFileSync(join(repo, "tools", "sdkref-operations.json"), "utf8"))),
  );
  const codes = errorCodes(readFileSync(join(repo, "src", "errors.ts"), "utf8"));
  const project = await convert(join(repo, "src", "index.ts"), join(repo, "tsconfig.build.json"));
  return serialise(build(project, { operations, codes, head: headOf(pkg) }));
}

/* c8 ignore start - the command line, exercised by CI */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const fresh = await generate();
  const path = join(REPO, OUTPUT);
  if (check) {
    let committed = "";
    try {
      committed = readFileSync(path, "utf8");
    } catch {
      // Missing is a difference like any other.
    }
    if (committed !== fresh) {
      console.error(
        `${OUTPUT} is not what the source generates: run node tools/sdkref.mjs and commit it`,
      );
      process.exit(1);
    }
    console.log(`${OUTPUT} matches the source`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, fresh);
    console.log(`wrote ${OUTPUT}`);
  }
}
/* c8 ignore stop */
