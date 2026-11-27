// `client.copy`: Copy Trading - leaders, followers, groups, stop-outs and the copy log.
//
// One of the tenant's accounts, or an external signal source, leads; other accounts follow it,
// each with its own scaling, bounds, symbol map, options and limits. The tenant chooses the
// leader, the scaling and the limits; MFX Hub executes and suggests none of them. Leaders and
// followers are trading accounts (`accountId`, the id `client.tradingAccounts` lists), each with
// its `venue`; a leader and its followers may be on different venues.
//
// Reads need `copy:read` and writes `copy:write`. Every write takes an `idempotencyKey` and is
// sent once, never retried. Each list has a `...Page` method answering one `CopyPage` (a `Page`
// with the list's `stats` row, counted over everything the filters match) and a method that
// follows the cursor. What became of each copy is on the copy log and in the `copy.*` events
// (`copyEventOf` in events.ts). A copy that did not fill names one of `REFUSAL_REASONS`.
//
// Nested settings (`scaling`, `bounds`, `options`, `riskLimits`, ...) are the contract's own
// objects, in its own snake_case names, typed from the API description. A decimal in them is a
// string; a JavaScript number that is not a whole number is refused anywhere in a body, because
// it is a binary float.

import { idempotencyKey, limit as pageLimit, uuid, words } from "./arguments.js";
import type { MfxClient } from "./client.js";
import { decimal } from "./decimals.js";
import type { Keyed } from "./execution.js";
import type { components } from "./generated/api.js";
import { Page, everyItem, pageOf } from "./pages.js";

type Schemas = components["schemas"];

/** A leader: its source and account, filters, what is copied, limits and who may join. */
export type CopyLeader = Schemas["CopyLeader"];
/** A follower: its mandate and version, its state and the stop-outs in force. */
export type CopyFollower = Schemas["CopyFollower"];
/** A group of followers under one template and one exposure cap (Enterprise). */
export type CopyGroup = Schemas["CopyGroup"];
/** One stop-out of a follower: the limit reached, what was used, what it closed. */
export type CopyStopout = Schemas["CopyStopout"];
/** One row of the copy log: one follower, one signal, its outcome, reason and stage timings. */
export type CopyLogEntry = Schemas["CopyLogEntry"];
/** What a follow would do: each row's follower symbol, match and volume, or its reason. */
export type CopyPreview = Schemas["CopyPreview"];
/** An accepted signal: MFX Hub's `signal_id`, your `id`, and whether it was a duplicate. */
export type CopySignalAccepted = Schemas["CopySignalAccepted"];
/** Each follower's outcome of a group membership change. */
export type CopyGroupMembersResult = Schemas["CopyGroupMembersResult"];
/** How a leader volume becomes the follower's: the mode and the figure it needs. */
export type CopyScaling = Schemas["CopyScaling"];
/** The follower's own limits on one copy, in its venue's unit. */
export type CopyBounds = Schemas["CopyBounds"];
/** The follower's copy options: reverse, copy SL / TP / pending, close only, delay. */
export type CopyOptions = Schemas["CopyOptions"];
/** The follower's copy limits as a percentage of `basis`, in the account's currency. */
export type CopyRiskLimits = Schemas["CopyRiskLimits"];
/** Which of the leader's deals are copied: symbols, tag, side. */
export type CopyLeaderFilters = Schemas["CopyLeaderFilters"];
/** What of the leader's trading is copied. */
export type CopyLeaderCopies = Schemas["CopyLeaderCopies"];
/** The leader-side limits: max risk a trade, max leverage. */
export type CopyLeaderLimits = Schemas["CopyLeaderLimits"];
/** Which accounts may follow the leader. */
export type CopyWhoMayJoin = Schemas["CopyWhoMayJoin"];
/** A group's template for the followers created into it. */
export type CopyGroupTemplate = Schemas["CopyGroupTemplate"];

// DECISION: a setting whose fields all have the contract's defaults is taken partly: the generated
// types make a defaulted field required, which is right for what the API answers and wrong for
// what a caller sends, where a field left out takes its default.

/** {@link CopyLeaderFilters} as a caller sends it: a field left out takes its default. */
export type LeaderFiltersInput = Partial<CopyLeaderFilters>;
/** {@link CopyLeaderCopies} as a caller sends it. */
export type LeaderCopiesInput = Partial<CopyLeaderCopies>;
/** {@link CopyWhoMayJoin} as a caller sends it. */
export type WhoMayJoinInput = Partial<CopyWhoMayJoin>;
/**
 * {@link CopyOptions} as a caller sends it. `when_risk_unchecked` is `"refuse"` (the default) or
 * `"copy"`. When the follower account is protected by Risk Management (an active policy or a
 * challenge in progress) and its copy host cannot yet check a copy against it: refuse refuses the
 * copy with risk_rule (reason risk_inputs_stale); copy copies it unchecked. Once the host can
 * check, every copy is checked whatever this says.
 */
export type CopyOptionsInput = Partial<CopyOptions>;
/** {@link CopyRiskLimits} as a caller sends it. */
export type CopyRiskLimitsInput = Partial<CopyRiskLimits>;
/** {@link CopyGroupTemplate} as a caller sends it. */
export type GroupTemplateInput = Omit<CopyGroupTemplate, "options" | "risk_limits"> & {
  readonly options?: CopyOptionsInput;
  readonly risk_limits?: CopyRiskLimitsInput;
};
/** One leader deal to try in a preview: a symbol and a volume in the leader venue's unit. */
export type CopyPreviewRow = Schemas["CopyPreviewRequest"]["rows"][number];
/** Where a leader's deals come from. */
export type CopyLeaderSource = Schemas["CopyLeaderSource"];
/** A leader's state; `retired` is final. */
export type CopyLeaderState = Schemas["CopyLeaderState"];
/** A follower's state; `unfollowed` is final. */
export type CopyFollowerState = Schemas["CopyFollowerState"];
/** A group's state. */
export type CopyGroupState = Schemas["CopyGroupState"];
/** A stop-out's state. */
export type CopyStopoutState = Schemas["CopyStopoutState"];
/** The follower limit a stop-out reached. */
export type CopyLimitKind = Schemas["CopyLimitKind"];
/** What became of one copy. */
export type CopyOutcome = Schemas["CopyOutcome"];
/** Why a copy did not fill. The list is closed: a new reason is a change to the contract. */
export type CopyReason = Schemas["CopyReason"];
/** The trading technology an account is on. */
export type CopyVenue = Schemas["Venue"];
/** The stats row of the leaders list. */
export type CopyLeaderStats = Schemas["CopyLeaderPage"]["stats"];
/** The stats row of the followers list. */
export type CopyFollowerStats = Schemas["CopyFollowerPage"]["stats"];
/** The stats row of the groups list. */
export type CopyGroupStats = Schemas["CopyGroupPage"]["stats"];
/** The stats row of the copy log, over the whole filtered window. */
export type CopyLogStats = Schemas["CopyLogPage"]["stats"];
/** A requested close of copied positions: each position it covers and each attempt. */
export type CopyClose = Schemas["CopyClose"];
/** A requested close's state. */
export type CopyCloseState = Schemas["CopyCloseState"];
/** The count of each state over every requested close the filters match. */
export type CopyCloseStats = Schemas["CopyClosePage"]["stats"];
/** What a group's close answers: the batch and each member's close. */
export type CopyGroupCloseResult = Schemas["CopyGroupCloseResult"];
/** What a group's rollover answers: each member's outcome and the next page. */
export type CopyGroupRolloverResult = Schemas["CopyGroupRolloverResult"];
/** A template field a rollover can set on a group's members. */
export type CopyRolloverField = NonNullable<Schemas["CopyGroupRollover"]["fields"]>[number];
/** One of your leaders' signals, with what became of its copies. */
export type CopySignalEntry = Schemas["CopySignalEntry"];
/** The count of signals by kind over everything the filters match. */
export type CopySignalStats = Schemas["CopySignalPage"]["stats"];
/** The count of each state over every stop-out the filters match. */
export type CopyStopoutStats = Schemas["CopyTenantStopoutPage"]["stats"];

/** Every refusal reason the contract names, in its order. */
export const REFUSAL_REASONS: readonly CopyReason[] = [
  "mapping",
  "min_volume",
  "no_stop",
  "risk_rule",
  "plan_limit",
  "stopped_out",
  "signal_expired",
  "skip_pending",
  "close_only",
  "paused",
  "account_not_connected",
  "market_closed",
  "no_conversion",
  "not_on_this_venue",
  "venue_unavailable",
  "broker",
];

const LEADER_STATES: readonly CopyLeaderState[] = ["active", "paused", "retired"];
const FOLLOWER_STATES: readonly CopyFollowerState[] = [
  "copying",
  "paused",
  "stopped_out",
  "unfollowed",
];
const GROUP_STATES: readonly CopyGroupState[] = ["active", "paused"];
const STOPOUT_STATES: readonly CopyStopoutState[] = ["active", "reset", "expired"];
const OUTCOMES: readonly CopyOutcome[] = ["filled", "refused", "skipped", "stopout"];
const VENUES: readonly CopyVenue[] = ["mt5", "ctrader"];
const SOURCES: readonly CopyLeaderSource[] = ["account", "external"];
const SORTS: readonly string[] = ["created_at", "mfx_ms"];
const NEWEST_OR_OLDEST: readonly string[] = ["newest", "oldest"];
const CLOSE_STATES: readonly CopyCloseState[] = ["pending", "done", "incomplete", "superseded"];
const ROLLOVER_FIELDS: readonly CopyRolloverField[] = [
  "scaling",
  "bounds",
  "options",
  "risk_limits",
  "close_on_stopout",
];
const SIGNAL_KINDS: readonly CopySignalEntry["kind"][] = ["fill", "external"];
const SIGNAL_ACTIONS: readonly CopySignalEntry["action"][] = [
  "open",
  "modify",
  "close",
  "close_part",
  "pending_place",
  "pending_modify",
  "pending_cancel",
];
const MEMBERS_MAX = 500;

/** A page of a copy list, with the list's `stats` row (null when the answer has none). */
export class CopyPage<T, S> extends Page<T> {
  /**
   * @param stats counts everything the filters (and, on the log, the window) match, not this
   *   page; the same on every page
   */
  constructor(
    items: readonly T[],
    nextCursor: string | null,
    returned: number | null,
    readonly stats: S | null,
  ) {
    super(items, nextCursor, returned);
  }
}

function copyPageOf<T, S>(body: unknown): CopyPage<T, S> {
  const page = pageOf<T>(body);
  const stats = (body as { stats?: S | null } | null)?.stats ?? null;
  return new CopyPage(page.items, page.nextCursor, page.returned, stats);
}

/** The cursor and page size every `...Page` method takes. */
export interface CopyPageOptions {
  /** The `nextCursor` of the page before; leave it out for the first page. */
  readonly cursor?: string;
  /** How many to a page, 1 to 200. */
  readonly limit?: number;
}

/** What {@link Copy.leadersPage} takes. */
export interface LeaderFilter extends CopyPageOptions {
  readonly state?: CopyLeaderState | readonly CopyLeaderState[];
  readonly source?: CopyLeaderSource;
  readonly accountId?: string;
}

/** What {@link Copy.followersPage} takes. */
export interface FollowerFilter extends CopyPageOptions {
  readonly state?: CopyFollowerState | readonly CopyFollowerState[];
  readonly leaderId?: string;
  readonly accountId?: string;
  /** A group's followers. */
  readonly groupId?: string;
  /** Only the followers whose copy host does not hold their latest mandate (or only those that do). */
  readonly outOfStep?: boolean;
  /** `newest` first (the platform's default) or `oldest`. */
  readonly sort?: "newest" | "oldest";
}

/** What {@link Copy.groupsPage} takes. */
export interface GroupFilter extends CopyPageOptions {
  readonly state?: CopyGroupState;
}

/** What {@link Copy.stopoutsPage} takes. */
export interface StopoutFilter extends CopyPageOptions {
  readonly state?: CopyStopoutState | readonly CopyStopoutState[];
}

/** What {@link Copy.logPage} takes. Every filter narrows the rows before the page is cut. */
export interface CopyLogFilter extends CopyPageOptions {
  readonly leaderId?: string;
  readonly followerId?: string;
  /** The follower account. */
  readonly accountId?: string;
  readonly signalId?: string;
  /** The group's followers now. */
  readonly groupId?: string;
  readonly outcome?: CopyOutcome | readonly CopyOutcome[];
  /** One of {@link REFUSAL_REASONS}, or several; any other word is a RangeError. */
  readonly reason?: CopyReason | readonly CopyReason[];
  readonly venue?: CopyVenue | readonly CopyVenue[];
  /** Start of the window; without it, the last 24 hours. At most 31 days. */
  readonly from?: Date;
  /** End of the window; now when left out. */
  readonly to?: Date;
  /** `created_at`, newest first (the default), or `mfx_ms`, the slowest of MFX Hub's part first. */
  readonly sort?: "created_at" | "mfx_ms";
}

/** A window, `from` to `to`, at most 31 days; without `from` it is the last 24 hours. */
export interface CopyWindow {
  readonly from?: Date;
  readonly to?: Date;
}

/** What {@link Copy.closesPage} takes. Every filter narrows the closes before the page is cut. */
export interface CloseFilter extends CopyPageOptions, CopyWindow {
  readonly followerId?: string;
  readonly leaderId?: string;
  readonly groupId?: string;
  /** A retire's or a group close's closes share one batch. */
  readonly batchId?: string;
  readonly state?: CopyCloseState | readonly CopyCloseState[];
}

/** What {@link Copy.signalsPage} takes. */
export interface SignalFilter extends CopyPageOptions, CopyWindow {
  readonly leaderId?: string;
  readonly kind?: CopySignalEntry["kind"] | readonly CopySignalEntry["kind"][];
  readonly action?: CopySignalEntry["action"] | readonly CopySignalEntry["action"][];
}

/** What {@link Copy.tenantStopoutsPage} takes. */
export interface TenantStopoutFilter extends CopyPageOptions, CopyWindow {
  readonly state?: CopyStopoutState | readonly CopyStopoutState[];
  readonly followerId?: string;
  /** The group's followers now. */
  readonly groupId?: string;
}

/** What {@link Copy.closeGroup} takes. `pause` has no default. */
export interface CloseGroup extends Keyed {
  /** Why, kept on each close and the audit row. */
  readonly reason: string;
  /** `true` pauses the group in the same act; `false` leaves its state. */
  readonly pause: boolean;
}

/** What {@link Copy.rolloverGroup} takes. */
export interface RolloverGroup {
  /** `true` answers what would change and changes nothing. */
  readonly dryRun: boolean;
  /** The template fields to set; by default every field the template sets. */
  readonly fields?: readonly CopyRolloverField[];
  /** The page after this member id: the previous answer's `next_after`. */
  readonly after?: string;
  /** How many members, 1 to 500. */
  readonly limit?: number;
  /** Required for an applied rollover; a dry run takes none. */
  readonly idempotencyKey?: string;
}

/** What {@link Copy.createLeader} takes. */
export interface CreateLeader extends Keyed {
  readonly source: CopyLeaderSource;
  /** The account that leads, when `source` is `account`. */
  readonly accountId?: string;
  /** How long a signal may still be copied after MFX Hub makes it, 1 to 3600 seconds. */
  readonly signalLifetimeS: number;
  readonly filters?: LeaderFiltersInput;
  readonly copies?: LeaderCopiesInput;
  readonly limits?: CopyLeaderLimits;
  readonly whoMayJoin?: WhoMayJoinInput;
}

/** What {@link Copy.updateLeader} takes: only the fields given are sent and change. */
export interface UpdateLeader extends Keyed {
  readonly filters?: LeaderFiltersInput;
  readonly copies?: LeaderCopiesInput;
  readonly signalLifetimeS?: number;
  readonly limits?: CopyLeaderLimits;
  readonly whoMayJoin?: WhoMayJoinInput;
}

/** What {@link Copy.retireLeader} takes. `closeCopied` has no default: closing is your choice. */
export interface RetireLeader extends Keyed {
  readonly closeCopied: boolean;
  readonly reason: string;
}

/** What {@link Copy.sendOpenSignal} takes. Exactly one of `volume` and `units`. */
export interface OpenSignal extends Keyed {
  /** Your id for the signal, unique for the leader; a close names it. */
  readonly id: string;
  readonly symbol: string;
  readonly side: "buy" | "sell";
  /** Lots of the instrument's standard contract in MFX Hub's catalogue, a decimal string. */
  readonly volume?: string;
  /** Base units, in place of volume, a decimal string. */
  readonly units?: string;
  /** The catalogue's instrument key, such as `fx:EURUSD`. */
  readonly instrumentKey?: string;
  /** The stop loss price, a decimal string; may be negative, as some instruments trade below 0. */
  readonly sl?: string;
  /** The take profit price, a decimal string; may be negative. */
  readonly tp?: string;
  /** The source's own time for the signal; kept, never used for its lifetime. */
  readonly time?: Date;
  /** The source's own account figures; kept with the signal, read by no follower. */
  readonly account?: Readonly<Record<string, unknown>>;
}

/** What {@link Copy.sendCloseSignal} takes. */
export interface CloseSignal extends Keyed {
  /** This signal's own id. */
  readonly id: string;
  /** The id of the open it closes. */
  readonly close: string;
  readonly time?: Date;
}

/** A follower's mandate, as {@link Copy.createFollower} and {@link Copy.updateFollower} take it. */
export interface Mandate {
  readonly scaling?: CopyScaling;
  readonly bounds?: CopyBounds;
  /** Leader symbol to follower symbol; wins over every other match. */
  readonly symbolMap?: Readonly<Record<string, string>>;
  readonly options?: CopyOptionsInput;
  readonly riskLimits?: CopyRiskLimitsInput;
  readonly closeOnStopout?: boolean;
}

/** What {@link Copy.createFollower} takes. `scaling` is required unless the group's template has it. */
export interface CreateFollower extends Mandate, Keyed {
  readonly accountId: string;
  readonly leaderId: string;
  /** Enterprise: the group it joins. */
  readonly groupId?: string;
}

/** What {@link Copy.updateFollower} takes: only the fields given are sent and change. */
export interface UpdateFollower extends Mandate, Keyed {}

/** What {@link Copy.previewFollower} takes. No idempotency key: nothing is created. */
export interface PreviewFollower {
  readonly accountId: string;
  readonly leaderId: string;
  readonly scaling: CopyScaling;
  /** 1 to 200 leader deals to try. */
  readonly rows: readonly CopyPreviewRow[];
  readonly bounds?: CopyBounds;
  readonly symbolMap?: Readonly<Record<string, string>>;
  readonly options?: CopyOptionsInput;
}

/** What {@link Copy.unfollow} takes. `closeCopied` has no default. */
export interface Unfollow extends Keyed {
  readonly closeCopied: boolean;
}

/** What {@link Copy.resetStopouts} takes. */
export interface ResetStopouts extends Keyed {
  readonly reason: string;
  /** Only the stop-out for this limit; every active one when left out. */
  readonly limit?: CopyLimitKind;
}

/** What {@link Copy.createGroup} takes. */
export interface CreateGroup extends Keyed {
  readonly name: string;
  readonly template?: GroupTemplateInput;
  /** A decimal string. */
  readonly grossExposureCap?: string;
  readonly placementPolicy?: string;
}

/** What {@link Copy.updateGroup} takes. `null` clears the cap or the policy. */
export interface UpdateGroup extends Keyed {
  readonly name?: string;
  readonly template?: GroupTemplateInput;
  readonly grossExposureCap?: string | null;
  readonly placementPolicy?: string | null;
}

/** A body as the contract writes it: refuse a binary float anywhere in it. */
function wire(name: string, value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError(
        `${name} is a number with a fraction (${String(value)}): a binary float. Pass a decimal ` +
          `as a string, such as "0.5"`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => wire(`${name}[${index}]`, item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, wire(`${name}.${key}`, item)]),
    );
  }
  return value;
}

/** Only the fields that were given; `undefined` is not sent, `null` is. */
function body(name: string, fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const given = Object.entries(fields).filter(([, value]) => value !== undefined);
  return wire(name, Object.fromEntries(given)) as Record<string, unknown>;
}

function optionalId(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : uuid(name, value);
}

function cursorOf(options: CopyPageOptions): string | undefined {
  if (options.cursor !== undefined && typeof options.cursor !== "string") {
    throw new TypeError("cursor is the nextCursor of the page before");
  }
  return options.cursor;
}

function instant(name: string, value: Date | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} is a Date`);
  }
  return value.toISOString();
}

/** A window as sent: each end an instant, and the end not before the start. */
function windowOf(
  what: string,
  options: CopyWindow,
): { from: string | undefined; to: string | undefined } {
  const from = instant("from", options.from);
  const to = instant("to", options.to);
  if (from !== undefined && to !== undefined && to < from) {
    throw new RangeError(`${what}'s window ends before it starts`);
  }
  return { from, to };
}

function text(name: string, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${name} is a non-empty string`);
  }
  return value;
}

function flag(name: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} is true or false, with no default`);
  return value;
}

function optionalDecimal(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : decimal(name, value);
}

/**
 * A decimal that may be negative, as the contract's `CopyDecimal` allows (`^-?...`): a stop loss
 * or take profit is a price, and some instruments trade below zero. The magnitude is checked as
 * every other decimal is; a number is refused.
 */
function optionalSignedDecimal(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return decimal(name, value);
  const text = value.trim();
  const negative = text.startsWith("-");
  const magnitude = decimal(name, negative ? text.slice(1) : text);
  return negative && /[1-9]/.test(magnitude) ? `-${magnitude}` : magnitude;
}

// The words of the generated type, exactly: a word the contract adds or drops is a compile error
// here, so the check before sending cannot drift from the API description.
const WHEN_RISK_UNCHECKED: { readonly [W in CopyOptions["when_risk_unchecked"]]: true } = {
  refuse: true,
  copy: true,
};

/** Copy options as sent: `when_risk_unchecked`, when given, is refuse or copy. */
function copyOptions<T>(name: string, options: T): T {
  if (typeof options !== "object" || options === null) return options;
  const word = (options as { readonly when_risk_unchecked?: unknown }).when_risk_unchecked;
  if (
    word !== undefined &&
    (typeof word !== "string" || !Object.hasOwn(WHEN_RISK_UNCHECKED, word))
  ) {
    throw new RangeError(
      `${name}.when_risk_unchecked is refuse or copy; got ${JSON.stringify(word)}`,
    );
  }
  return options;
}

/** A group template as sent, its options checked. */
function template<T>(name: string, value: T): T {
  if (typeof value === "object" && value !== null) {
    copyOptions(`${name}.options`, (value as { readonly options?: unknown }).options);
  }
  return value;
}

/** Copy Trading for this key's tenant: `client.copy`. */
export class Copy {
  readonly #client: MfxClient;

  constructor(client: MfxClient) {
    this.#client = client;
  }

  async #write<T>(method: "POST" | "PATCH", path: string, key: string, payload?: unknown) {
    return (await this.#client.write({
      method,
      path,
      ...(payload === undefined ? {} : { body: payload }),
      idempotencyKey: idempotencyKey(key),
    })) as T;
  }

  // ------------------------------------------------------------------------------------ leaders

  /**
   * Make one of your accounts (`source: "account"` with `accountId`), or an external signal
   * source, a leader. An account leads once (`ConflictError`, `account_already_leads`); over the
   * plan's leaders is a `ConflictError` with code `quota_exceeded`. Sent once, never retried.
   */
  async createLeader(options: CreateLeader): Promise<CopyLeader> {
    if (!SOURCES.includes(options.source)) {
      throw new RangeError(`source is account or external; got ${JSON.stringify(options.source)}`);
    }
    const payload = body("createLeader", {
      source: options.source,
      account_id: optionalId("accountId", options.accountId),
      signal_lifetime_s: options.signalLifetimeS,
      filters: options.filters,
      copies: options.copies,
      limits: options.limits,
      who_may_join: options.whoMayJoin,
    });
    return this.#write<CopyLeader>("POST", "/copy/leaders", options.idempotencyKey, payload);
  }

  /** One leader; another tenant's id is a `NotFoundError`. */
  async getLeader(leaderId: string): Promise<CopyLeader> {
    const id = uuid("leaderId", leaderId);
    return (await this.#client.read({ method: "GET", path: `/copy/leaders/${id}` })) as CopyLeader;
  }

  /** One page of your leaders, newest first, with the count of each state in `stats`. */
  async leadersPage(options: LeaderFilter = {}): Promise<CopyPage<CopyLeader, CopyLeaderStats>> {
    if (options.source !== undefined && !SOURCES.includes(options.source)) {
      throw new RangeError(`source is account or external; got ${JSON.stringify(options.source)}`);
    }
    const answer = await this.#client.read({
      method: "GET",
      path: "/copy/leaders",
      query: {
        cursor: cursorOf(options),
        limit: pageLimit(options.limit),
        state: words("state", options.state, LEADER_STATES),
        source: options.source,
        account_id: optionalId("accountId", options.accountId),
      },
    });
    return copyPageOf(answer);
  }

  /** Every leader, following the cursor, one request a page. */
  leaders(options: Omit<LeaderFilter, "cursor"> = {}): AsyncGenerator<CopyLeader, void, undefined> {
    return everyItem((cursor) =>
      this.leadersPage({ ...options, ...(cursor === undefined ? {} : { cursor }) }),
    );
  }

  /** Change what a leader's followers receive, from its next deal. A retired one is a `StateError`. */
  async updateLeader(leaderId: string, options: UpdateLeader): Promise<CopyLeader> {
    const id = uuid("leaderId", leaderId);
    const payload = body("updateLeader", {
      filters: options.filters,
      copies: options.copies,
      signal_lifetime_s: options.signalLifetimeS,
      limits: options.limits,
      who_may_join: options.whoMayJoin,
    });
    return this.#write<CopyLeader>("PATCH", `/copy/leaders/${id}`, options.idempotencyKey, payload);
  }

  /** Stop copying the leader's new entries; its closes and stop changes are still copied. */
  async pauseLeader(leaderId: string, options: Keyed): Promise<CopyLeader> {
    const id = uuid("leaderId", leaderId);
    return this.#write<CopyLeader>("POST", `/copy/leaders/${id}/pause`, options.idempotencyKey);
  }

  /** Copy the leader's entries again, from its next deal. */
  async resumeLeader(leaderId: string, options: Keyed): Promise<CopyLeader> {
    const id = uuid("leaderId", leaderId);
    return this.#write<CopyLeader>("POST", `/copy/leaders/${id}/resume`, options.idempotencyKey);
  }

  /**
   * Retire a leader: every follow of it ends. With `closeCopied` each follower's volume copied
   * from it is closed, never the account's own positions. Retired is final when this returns;
   * each follower's close is a requested close (`cause: leader_retired`) under one `batch_id`,
   * followed by {@link closesPage} with `leaderId`, and final at `done` or `incomplete` with one
   * `copy.closed` each.
   */
  async retireLeader(leaderId: string, options: RetireLeader): Promise<CopyLeader> {
    const id = uuid("leaderId", leaderId);
    const payload = {
      close_copied: flag("closeCopied", options.closeCopied),
      reason: text("reason", options.reason),
    };
    return this.#write<CopyLeader>(
      "POST",
      `/copy/leaders/${id}/retire`,
      options.idempotencyKey,
      payload,
    );
  }

  /**
   * An external leader opens a position (a market entry). Exactly one of `volume` and `units`,
   * as decimal strings; both, neither or a number is refused before sending. An `id` sent before
   * is answered with the original signal, `duplicate` true; nothing is copied twice.
   */
  async sendOpenSignal(leaderId: string, options: OpenSignal): Promise<CopySignalAccepted> {
    const id = uuid("leaderId", leaderId);
    // DECISION: both or neither of volume and units is refused here, before the wire: the
    // contract answers it 422 volume_or_units, and the SDK refuses what it can see is wrong.
    if ((options.volume === undefined) === (options.units === undefined)) {
      throw new RangeError("an open signal takes exactly one of volume and units");
    }
    if (!["buy", "sell"].includes(options.side)) {
      throw new RangeError(`side is buy or sell; got ${JSON.stringify(options.side)}`);
    }
    const payload = body("sendOpenSignal", {
      id: text("id", options.id),
      symbol: text("symbol", options.symbol),
      side: options.side,
      volume: optionalDecimal("volume", options.volume),
      units: optionalDecimal("units", options.units),
      instrument_key: options.instrumentKey,
      sl: optionalSignedDecimal("sl", options.sl),
      tp: optionalSignedDecimal("tp", options.tp),
      time: instant("time", options.time),
      account: options.account,
    });
    return this.#write<CopySignalAccepted>(
      "POST",
      `/copy/leaders/${id}/signals`,
      options.idempotencyKey,
      payload,
    );
  }

  /** An external leader closes the position an earlier open made: `close` is that open's id. */
  async sendCloseSignal(leaderId: string, options: CloseSignal): Promise<CopySignalAccepted> {
    const id = uuid("leaderId", leaderId);
    const payload = body("sendCloseSignal", {
      id: text("id", options.id),
      close: text("close", options.close),
      time: instant("time", options.time),
    });
    return this.#write<CopySignalAccepted>(
      "POST",
      `/copy/leaders/${id}/signals`,
      options.idempotencyKey,
      payload,
    );
  }

  // ---------------------------------------------------------------------------------- followers

  /**
   * Make one of your accounts follow a leader. Checked once, here, against the account's venue:
   * an option the venue cannot honour is a `ValidationError` naming `not_on_this_venue`. Use
   * {@link Copy.previewFollower} first to see each symbol's match and volume.
   */
  async createFollower(options: CreateFollower): Promise<CopyFollower> {
    const payload = body("createFollower", {
      account_id: uuid("accountId", options.accountId),
      leader_id: uuid("leaderId", options.leaderId),
      ...mandate(options),
      group_id: optionalId("groupId", options.groupId),
    });
    return this.#write<CopyFollower>("POST", "/copy/followers", options.idempotencyKey, payload);
  }

  /**
   * What a follow would do before it is made: each row's follower symbol, how it was matched and
   * its volume, or the reason it would be refused. A read (`copy:read`): no idempotency key, and
   * retried after a 429 as every read is.
   */
  async previewFollower(options: PreviewFollower): Promise<CopyPreview> {
    if (!Array.isArray(options.rows) || options.rows.length < 1 || options.rows.length > 200) {
      throw new RangeError("a preview takes 1 to 200 rows");
    }
    const payload = body("previewFollower", {
      account_id: uuid("accountId", options.accountId),
      leader_id: uuid("leaderId", options.leaderId),
      scaling: options.scaling,
      rows: options.rows,
      bounds: options.bounds,
      symbol_map: options.symbolMap,
      options: copyOptions("options", options.options),
    });
    // DECISION: a preview creates nothing, so it is sent as a read: retried after a 429, and
    // never given an idempotency key the contract does not take.
    return (await this.#client.read({
      method: "POST",
      path: "/copy/followers/preview",
      body: payload,
    })) as CopyPreview;
  }

  /** One follower: its mandate and version, its state and its stop-outs in force. */
  async getFollower(followerId: string): Promise<CopyFollower> {
    const id = uuid("followerId", followerId);
    return (await this.#client.read({
      method: "GET",
      path: `/copy/followers/${id}`,
    })) as CopyFollower;
  }

  /**
   * One page of your followers, newest first (`sort: "oldest"` the other way), with the count of
   * each state, and of those out of step, in `stats`. Each follower carries what is live: `drift`,
   * `limits_use`, `today`, its `exposure` against its group's cap and its requested `close`, each
   * null when there is none.
   */
  async followersPage(
    options: FollowerFilter = {},
  ): Promise<CopyPage<CopyFollower, CopyFollowerStats>> {
    const answer = await this.#client.read({
      method: "GET",
      path: "/copy/followers",
      query: {
        cursor: cursorOf(options),
        limit: pageLimit(options.limit),
        state: words("state", options.state, FOLLOWER_STATES),
        leader_id: optionalId("leaderId", options.leaderId),
        account_id: optionalId("accountId", options.accountId),
        group_id: optionalId("groupId", options.groupId),
        out_of_step:
          options.outOfStep === undefined ? undefined : flag("outOfStep", options.outOfStep),
        sort: oneOf("sort", options.sort, NEWEST_OR_OLDEST),
      },
    });
    return copyPageOf(answer);
  }

  /** Every follower, following the cursor, one request a page. */
  followers(
    options: Omit<FollowerFilter, "cursor"> = {},
  ): AsyncGenerator<CopyFollower, void, undefined> {
    return everyItem((cursor) =>
      this.followersPage({ ...options, ...(cursor === undefined ? {} : { cursor }) }),
    );
  }

  /** Change a follower's mandate; each change is a new `mandate_version`. */
  async updateFollower(followerId: string, options: UpdateFollower): Promise<CopyFollower> {
    const id = uuid("followerId", followerId);
    const payload = body("updateFollower", mandate(options));
    return this.#write<CopyFollower>(
      "PATCH",
      `/copy/followers/${id}`,
      options.idempotencyKey,
      payload,
    );
  }

  /** Stop copying new entries to this follower; closes of what it copied still are. */
  async pauseFollower(followerId: string, options: Keyed): Promise<CopyFollower> {
    return this.#followerAction(followerId, "pause", options);
  }

  /** Copy to this follower again; `stopped_out` while a stop-out is still active. */
  async resumeFollower(followerId: string, options: Keyed): Promise<CopyFollower> {
    return this.#followerAction(followerId, "resume", options);
  }

  /** Send the mandate again and heal the copied positions from the account; nothing is traded. */
  async resyncFollower(followerId: string, options: Keyed): Promise<CopyFollower> {
    return this.#followerAction(followerId, "resync", options);
  }

  async #followerAction(
    followerId: string,
    action: "pause" | "resume" | "resync",
    options: Keyed,
  ): Promise<CopyFollower> {
    const id = uuid("followerId", followerId);
    return this.#write<CopyFollower>(
      "POST",
      `/copy/followers/${id}/${action}`,
      options.idempotencyKey,
    );
  }

  /**
   * End the follow (final). With `closeCopied` the volume copied from this leader is closed,
   * never the account's own; without it the copied positions stay open. The close is a requested
   * close, the answer's `close`: final at `done` or `incomplete`, with one `copy.closed`;
   * {@link getClose} has each position and attempt.
   */
  async unfollow(followerId: string, options: Unfollow): Promise<CopyFollower> {
    const id = uuid("followerId", followerId);
    return this.#write<CopyFollower>(
      "POST",
      `/copy/followers/${id}/unfollow`,
      options.idempotencyKey,
      { close_copied: flag("closeCopied", options.closeCopied) },
    );
  }

  // ---------------------------------------------------------------------------------- stop-outs

  /** One page of a follower's stop-outs, newest first. */
  async stopoutsPage(followerId: string, options: StopoutFilter = {}): Promise<Page<CopyStopout>> {
    const id = uuid("followerId", followerId);
    const answer = await this.#client.read({
      method: "GET",
      path: `/copy/followers/${id}/stopouts`,
      query: {
        cursor: cursorOf(options),
        limit: pageLimit(options.limit),
        state: words("state", options.state, STOPOUT_STATES),
      },
    });
    return pageOf<CopyStopout>(answer);
  }

  /** Every stop-out of a follower, following the cursor. */
  stopouts(
    followerId: string,
    options: Omit<StopoutFilter, "cursor"> = {},
  ): AsyncGenerator<CopyStopout, void, undefined> {
    return everyItem((cursor) =>
      this.stopoutsPage(followerId, { ...options, ...(cursor === undefined ? {} : { cursor }) }),
    );
  }

  /**
   * Reset a follower's active stop-outs, or only the one for `limit`, with a reason. Positions a
   * stop-out closed stay closed. None active is a `StateError` (`no_active_stopout`).
   */
  async resetStopouts(followerId: string, options: ResetStopouts): Promise<CopyFollower> {
    const id = uuid("followerId", followerId);
    const payload = body("resetStopouts", {
      reason: text("reason", options.reason),
      limit: options.limit,
    });
    return this.#write<CopyFollower>(
      "POST",
      `/copy/followers/${id}/stopouts/reset`,
      options.idempotencyKey,
      payload,
    );
  }

  // ------------------------------------------------------------------------------------- groups

  /**
   * A group of followers under one template and one exposure cap (Enterprise). The cap is in US
   * dollars, an equal share of it signed to each live member. `placementPolicy` is deprecated:
   * stored and returned, never read by placement.
   */
  async createGroup(options: CreateGroup): Promise<CopyGroup> {
    const payload = body("createGroup", {
      name: text("name", options.name),
      template: template("template", options.template),
      gross_exposure_cap: optionalDecimal("grossExposureCap", options.grossExposureCap),
      placement_policy: options.placementPolicy,
    });
    return this.#write<CopyGroup>("POST", "/copy/groups", options.idempotencyKey, payload);
  }

  /** One group, with its template, exposure cap and how many followers it has. */
  async getGroup(groupId: string): Promise<CopyGroup> {
    const id = uuid("groupId", groupId);
    return (await this.#client.read({ method: "GET", path: `/copy/groups/${id}` })) as CopyGroup;
  }

  /** One page of your groups, newest first, with the count of each state in `stats`. */
  async groupsPage(options: GroupFilter = {}): Promise<CopyPage<CopyGroup, CopyGroupStats>> {
    const answer = await this.#client.read({
      method: "GET",
      path: "/copy/groups",
      query: {
        cursor: cursorOf(options),
        limit: pageLimit(options.limit),
        state: words("state", options.state, GROUP_STATES),
      },
    });
    return copyPageOf(answer);
  }

  /** Every group, following the cursor. */
  groups(options: Omit<GroupFilter, "cursor"> = {}): AsyncGenerator<CopyGroup, void, undefined> {
    return everyItem((cursor) =>
      this.groupsPage({ ...options, ...(cursor === undefined ? {} : { cursor }) }),
    );
  }

  /** Change a group; only the fields given are sent, and `null` clears the cap or the policy. */
  async updateGroup(groupId: string, options: UpdateGroup): Promise<CopyGroup> {
    const id = uuid("groupId", groupId);
    const cap = options.grossExposureCap;
    const payload = body("updateGroup", {
      name: options.name === undefined ? undefined : text("name", options.name),
      template: template("template", options.template),
      gross_exposure_cap:
        cap === null || cap === undefined ? cap : decimal("grossExposureCap", cap),
      placement_policy: options.placementPolicy,
    });
    return this.#write<CopyGroup>("PATCH", `/copy/groups/${id}`, options.idempotencyKey, payload);
  }

  /** Add 1 to 500 followers to a group; each one's outcome is answered apart. */
  async addGroupFollowers(
    groupId: string,
    followerIds: readonly string[],
    options: Keyed,
  ): Promise<CopyGroupMembersResult> {
    return this.#members(groupId, "followers", followerIds, options);
  }

  /** Take followers out of a group; they keep following with their own mandates. */
  async removeGroupFollowers(
    groupId: string,
    followerIds: readonly string[],
    options: Keyed,
  ): Promise<CopyGroupMembersResult> {
    return this.#members(groupId, "followers/remove", followerIds, options);
  }

  async #members(
    groupId: string,
    route: string,
    followerIds: readonly string[],
    options: Keyed,
  ): Promise<CopyGroupMembersResult> {
    const id = uuid("groupId", groupId);
    if (!Array.isArray(followerIds) || followerIds.length < 1 || followerIds.length > MEMBERS_MAX) {
      throw new RangeError(`a group change takes 1 to ${MEMBERS_MAX} follower ids`);
    }
    const ids = followerIds.map((each, index) => uuid(`followerIds[${index}]`, each));
    return this.#write<CopyGroupMembersResult>(
      "POST",
      `/copy/groups/${id}/${route}`,
      options.idempotencyKey,
      { follower_ids: ids },
    );
  }

  /** Stop copying new entries to every follower of the group; closes still are. */
  async pauseGroup(groupId: string, options: Keyed): Promise<CopyGroup> {
    const id = uuid("groupId", groupId);
    return this.#write<CopyGroup>("POST", `/copy/groups/${id}/pause`, options.idempotencyKey);
  }

  /** Copy to the group's followers again, from the leader's next deal. */
  async resumeGroup(groupId: string, options: Keyed): Promise<CopyGroup> {
    const id = uuid("groupId", groupId);
    return this.#write<CopyGroup>("POST", `/copy/groups/${id}/resume`, options.idempotencyKey);
  }

  /**
   * Close the copied positions of every live member of the group (Enterprise); the follows are
   * kept. Each member gets one requested close (`cause: group_close`), all under one `batch_id`,
   * covering what was copied from leader deals signalled up to now; only copied volume is closed,
   * never the account's own. `pause` has no default: `true` pauses the group in the same act,
   * `false` leaves its state. {@link closesPage} with `batchId` follows the progress.
   */
  async closeGroup(groupId: string, options: CloseGroup): Promise<CopyGroupCloseResult> {
    const id = uuid("groupId", groupId);
    const payload = body("closeGroup", {
      reason: text("reason", options.reason),
      pause: flag("pause", options.pause),
    });
    return this.#write<CopyGroupCloseResult>(
      "POST",
      `/copy/groups/${id}/close`,
      options.idempotencyKey,
      payload,
    );
  }

  /**
   * Set the group's template on its live members, or with `dryRun: true` see what it would change
   * (Enterprise). Each member, in id order after `after`, at most `limit`, is answered `changed`
   * (each field's `from` and `to`), `unchanged` or `refused` with the reason; `next_after`
   * continues with the next page. A dry run changes nothing and sends no key; an applied rollover
   * needs `idempotencyKey`.
   */
  async rolloverGroup(groupId: string, options: RolloverGroup): Promise<CopyGroupRolloverResult> {
    const id = uuid("groupId", groupId);
    const dryRun = flag("dryRun", options.dryRun);
    // DECISION: the contract requires the key unless dry_run is true (400 without it), and a dry
    // run needs none; the SDK checks both here, before anything is sent.
    if (!dryRun && options.idempotencyKey === undefined) {
      throw new TypeError("an applied rolloverGroup (dryRun: false) needs an idempotencyKey");
    }
    if (dryRun && options.idempotencyKey !== undefined) {
      throw new TypeError("a dry run of rolloverGroup changes nothing and takes no key");
    }
    if (options.fields !== undefined) words("fields", options.fields, ROLLOVER_FIELDS);
    const payload = body("rolloverGroup", {
      dry_run: dryRun,
      fields: options.fields,
      after: optionalId("after", options.after),
      limit: membersLimit(options.limit),
    });
    return (await this.#client.write({
      method: "POST",
      path: `/copy/groups/${id}/rollover`,
      body: payload,
      ...(dryRun ? {} : { idempotencyKey: idempotencyKey(options.idempotencyKey) }),
    })) as CopyGroupRolloverResult;
  }

  // --------------------------------------------------------------------------- requested closes

  /**
   * One page of your requested closes of copied positions, newest first, with a count of each
   * state in `stats`: each an unfollow or a retire with `closeCopied`, or a group's close. A
   * retire's or a group close's closes share one `batch_id`. The window is on when the close was
   * asked, at most 31 days; without `from` it is the last 24 hours.
   */
  async closesPage(options: CloseFilter = {}): Promise<CopyPage<CopyClose, CopyCloseStats>> {
    const { from, to } = windowOf("the closes", options);
    const answer = await this.#client.read({
      method: "GET",
      path: "/copy/closes",
      query: {
        cursor: cursorOf(options),
        limit: pageLimit(options.limit),
        follower_id: optionalId("followerId", options.followerId),
        leader_id: optionalId("leaderId", options.leaderId),
        group_id: optionalId("groupId", options.groupId),
        batch_id: optionalId("batchId", options.batchId),
        state: words("state", options.state, CLOSE_STATES),
        from,
        to,
      },
    });
    return copyPageOf(answer);
  }

  /** Every requested close the filters and window match, following the cursor. */
  closes(options: Omit<CloseFilter, "cursor"> = {}): AsyncGenerator<CopyClose, void, undefined> {
    return everyItem((cursor) =>
      this.closesPage({ ...options, ...(cursor === undefined ? {} : { cursor }) }),
    );
  }

  /** One requested close: each copied position it covers and each attempt to close it. */
  async getClose(closeId: string): Promise<CopyClose> {
    const id = uuid("closeId", closeId);
    return (await this.#client.read({ method: "GET", path: `/copy/closes/${id}` })) as CopyClose;
  }

  // ---------------------------------------------------------------- signals and every stop-out

  /**
   * One page of your leaders' signals, newest first, each with `outcomes`: how many of its own
   * copies were filled, refused and skipped. `kind` and `action` go comma-separated, checked here;
   * the window is at most 31 days, the last 24 hours without `from`.
   */
  async signalsPage(
    options: SignalFilter = {},
  ): Promise<CopyPage<CopySignalEntry, CopySignalStats>> {
    const { from, to } = windowOf("the signals", options);
    const answer = await this.#client.read({
      method: "GET",
      path: "/copy/signals",
      query: {
        cursor: cursorOf(options),
        limit: pageLimit(options.limit),
        from,
        to,
        leader_id: optionalId("leaderId", options.leaderId),
        kind: words("kind", options.kind, SIGNAL_KINDS),
        action: words("action", options.action, SIGNAL_ACTIONS),
      },
    });
    return copyPageOf(answer);
  }

  /** Every signal the filters and window match, following the cursor. */
  signals(
    options: Omit<SignalFilter, "cursor"> = {},
  ): AsyncGenerator<CopySignalEntry, void, undefined> {
    return everyItem((cursor) =>
      this.signalsPage({ ...options, ...(cursor === undefined ? {} : { cursor }) }),
    );
  }

  /**
   * One page of every stop-out of your followers, newest first, with a count of each state in
   * `stats`; the window is on each stop-out's `created_at`. One follower's are
   * {@link stopoutsPage}.
   */
  async tenantStopoutsPage(
    options: TenantStopoutFilter = {},
  ): Promise<CopyPage<CopyStopout, CopyStopoutStats>> {
    const { from, to } = windowOf("the stop-outs", options);
    const answer = await this.#client.read({
      method: "GET",
      path: "/copy/stopouts",
      query: {
        cursor: cursorOf(options),
        limit: pageLimit(options.limit),
        from,
        to,
        state: words("state", options.state, STOPOUT_STATES),
        follower_id: optionalId("followerId", options.followerId),
        group_id: optionalId("groupId", options.groupId),
      },
    });
    return copyPageOf(answer);
  }

  /** Every stop-out of your followers the filters and window match, following the cursor. */
  tenantStopouts(
    options: Omit<TenantStopoutFilter, "cursor"> = {},
  ): AsyncGenerator<CopyStopout, void, undefined> {
    return everyItem((cursor) =>
      this.tenantStopoutsPage({ ...options, ...(cursor === undefined ? {} : { cursor }) }),
    );
  }

  // ------------------------------------------------------------------------------------ the log

  /**
   * One page of the copy log: one row a follower a signal, with its outcome, reason, the command
   * it became and MFX Hub's stage timings in milliseconds. `outcome`, `reason` and `venue` go as
   * one comma-separated value each, checked here; the window is at most 31 days (wider is a
   * `ValidationError`, `window_too_wide`). `stats` is over the whole filtered window. Each row
   * names the leader's `deal`, the follower's `symbol` and, when Risk Management refused the copy,
   * `risk`: the rule, the policy or challenge with its version, and the figures as text.
   */
  async logPage(options: CopyLogFilter = {}): Promise<CopyPage<CopyLogEntry, CopyLogStats>> {
    const { from, to } = windowOf("the copy log", options);
    if (options.sort !== undefined && !SORTS.includes(options.sort)) {
      throw new RangeError(`sort is created_at or mfx_ms; got ${JSON.stringify(options.sort)}`);
    }
    const answer = await this.#client.read({
      method: "GET",
      path: "/copy/log",
      query: {
        cursor: cursorOf(options),
        limit: pageLimit(options.limit),
        leader_id: optionalId("leaderId", options.leaderId),
        follower_id: optionalId("followerId", options.followerId),
        account_id: optionalId("accountId", options.accountId),
        group_id: optionalId("groupId", options.groupId),
        signal_id: optionalId("signalId", options.signalId),
        outcome: words("outcome", options.outcome, OUTCOMES),
        reason: words("reason", options.reason, REFUSAL_REASONS),
        venue: words("venue", options.venue, VENUES),
        from,
        to,
        sort: options.sort,
      },
    });
    return copyPageOf(answer);
  }

  /** Every row of the copy log the filters and window match, following the cursor. */
  log(options: Omit<CopyLogFilter, "cursor"> = {}): AsyncGenerator<CopyLogEntry, void, undefined> {
    return everyItem((cursor) =>
      this.logPage({ ...options, ...(cursor === undefined ? {} : { cursor }) }),
    );
  }
}

/** A rollover's page of members: 1 to 500. */
function membersLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MEMBERS_MAX) {
    throw new RangeError(
      `limit is a whole number, 1 to ${MEMBERS_MAX}; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function oneOf<T extends string>(
  name: string,
  value: T | undefined,
  allowed: readonly string[],
): T | undefined {
  if (value !== undefined && !allowed.includes(value)) {
    throw new RangeError(`${name} is one of ${allowed.join(", ")}; got ${JSON.stringify(value)}`);
  }
  return value;
}

function mandate(options: Mandate): Record<string, unknown> {
  return {
    scaling: options.scaling,
    bounds: options.bounds,
    symbol_map: options.symbolMap,
    options: copyOptions("options", options.options),
    risk_limits: options.riskLimits,
    close_on_stopout: options.closeOnStopout,
  };
}
