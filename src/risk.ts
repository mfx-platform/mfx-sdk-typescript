// `client.risk`: Risk Management - account rules, the trade planner, exit plans and challenges.
//
// The rules, thresholds and actions are yours. MFX Hub runs them on the account's own numbers and
// says what it did and why. Scopes: `risk:read` to read, `risk:write` to change, `risk:override`
// to relax protection, end an activation or clear a breach.
//
// A new entry that breaks a rule in force is refused with `RiskRefusedError`, whose `refusal`
// names the rule, the figure used, its limit and what the entry would have made it. Closes,
// partial closes and cancels are never refused.
//
// Bodies (rules, steps, orders) are the contract's shapes. Every figure in them is a decimal
// string: a number with a fraction is refused before anything is sent, because it has already
// been rounded (0.07 * 3 is 0.21000000000000002). Whole numbers (a version, a count of days) go
// as given.
//
// Lists come two ways: `...Page` reads one page with its `stats` over the filtered set, and the
// plural name follows the cursor to the end. A filter takes one value or several, sent as
// repeated parameters. A cursor belongs to the sort it was issued for.

import { idempotencyKey, limit as pageLimit, uuid } from "./arguments.js";
import type { MfxClient } from "./client.js";
import { decimal } from "./decimals.js";
import type { components } from "./generated/api.js";
import { everyItem, pageOf, type Page } from "./pages.js";

type S = components["schemas"];

/** A policy: its current version and the accounts it is on. */
export type RiskPolicy = S["RiskPolicy"];
/** One version of a policy, with what changed and who made it. */
export type RiskPolicyVersion = S["RiskPolicyVersion"];
/** A policy's rules, as the contract writes them. */
export type RiskRules = S["RiskRules"];
/** One protected account's figures, coverage and restriction. */
export type RiskAccount = S["RiskAccount"];
/** A page of accounts, with `stats` over the whole set. */
export type RiskAccountPage = S["RiskAccountPage"];
/** An activation's outcome, one per account. */
export type RiskActivationResult = S["RiskActivationResult"];
/** What a `close_positions` action would close now. */
export type RiskCloseScope = S["RiskCloseScope"];
/** Coverage by kind and state, and where it is not healthy. */
export type RiskCoverageSummary = S["RiskCoverageSummary"];
/** An account's equity and balance from its stored reads. */
export type RiskEquitySeries = S["RiskEquitySeries"];
/** A sized trade and every rule's check. */
export type RiskPreview = S["RiskPreview"];
/** What {@link Risk.preview} takes. */
export type RiskPreviewRequest = S["RiskPreviewRequest"];
/** An order already sized, as the pre-trade check judges it. */
export type RiskProposedOrder = S["RiskProposedOrder"];
/** The pre-trade check's verdict and every rule's check. */
export type RiskCheckResult = S["RiskCheckResult"];
/** An exit plan and its steps. */
export type RiskPlan = S["RiskPlan"];
/** What {@link Risk.createPlan} takes. */
export type RiskPlanCreate = S["RiskPlanCreate"];
/** One step of an exit plan, as it is asked for. */
export type RiskPlanStepSpec = S["RiskPlanStepSpec"];
/** A page of plans, with `stats` over the filtered set. */
export type RiskPlanPage = S["RiskPlanPage"];
/** A challenge, its current rule set and its counts. */
export type RiskChallenge = S["RiskChallenge"];
/** A challenge's rule set. */
export type RiskChallengeRules = S["RiskChallengeRules"];
/** One account of a challenge, with its figures and result. */
export type RiskChallengeAccount = S["RiskChallengeAccount"];
/** One account of a challenge, with its periods. */
export type RiskChallengeAccountDetail = S["RiskChallengeAccountDetail"];
/** A page of a challenge's accounts, with `stats` over the filtered set. */
export type RiskChallengeAccountPage = S["RiskChallengeAccountPage"];
/** One warning, breach, action or change. */
export type RiskActivity = S["RiskActivity"];
/** A page of activity, with `stats` over the filtered set. */
export type RiskActivityPage = S["RiskActivityPage"];

/** One value or several. */
export type OneOrMany<T extends string> = T | readonly T[];
export type Coverage = "healthy" | "degraded" | "disconnected" | "unknown" | "no_rules";
export type Restriction = "none" | "entries_blocked";
export type AccountSort = "daily_loss_used" | "drawdown_used" | "exposure" | "inputs_age" | "plans";
export type PlanState = RiskPlan["state"];
export type TimeSort = "newest" | "oldest";
export type ActivitySort = "unresolved_first" | "newest" | "oldest";
export type ChallengeState = RiskChallengeAccount["state"];
export type ChallengeRule = "daily_loss" | "max_drawdown";
export type ChallengeSort =
  "daily_loss_used" | "drawdown" | "profit" | "trading_days" | "period_ends_at";
export type CloseScope = "mfx_positions" | "all_positions";

interface Paged {
  /** The `nextCursor` of the page before; leave it out for the first page. */
  readonly cursor?: string;
  /** How many to a page, 1 to 200. */
  readonly limit?: number;
}

/** What {@link Risk.accountsPage} takes. */
export interface AccountListOptions extends Paged {
  readonly coverage?: OneOrMany<Coverage>;
  readonly restriction?: OneOrMany<Restriction>;
  readonly sort?: AccountSort;
}

/** What {@link Risk.plansPage} takes. */
export interface PlanListOptions extends Paged {
  readonly accountId?: string | readonly string[];
  readonly state?: OneOrMany<PlanState>;
  readonly sort?: TimeSort;
}

/** What {@link Risk.challengeAccountsPage} takes. */
export interface ChallengeAccountListOptions extends Paged {
  readonly state?: OneOrMany<ChallengeState>;
  readonly rule?: OneOrMany<ChallengeRule>;
  readonly belowMinDays?: boolean;
  readonly sort?: ChallengeSort;
}

/** What {@link Risk.activityPage} takes. */
export interface ActivityListOptions extends Paged {
  readonly kind?: OneOrMany<S["RiskActivityKind"]>;
  readonly accountId?: string | readonly string[];
  readonly outcome?: OneOrMany<S["RiskOutcome"]>;
  readonly from?: Date;
  readonly to?: Date;
  readonly sort?: ActivitySort;
}

/** A write's key, and a reason where one is needed. */
export interface Reasoned {
  readonly reason: string;
  readonly idempotencyKey: string;
}

function many(name: string, value: string | readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const values: readonly string[] = typeof value === "string" ? [value] : value;
  for (const each of values) {
    if (typeof each !== "string" || each === "") {
      throw new TypeError(`${name} is one value or a list of them`);
    }
  }
  return values.length === 0 ? undefined : [...values];
}

function ids(name: string, value: string | readonly string[] | undefined): string[] | undefined {
  return many(name, value)?.map((v) => uuid(name, v));
}

function reasonOf(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("reason is required: say why, it is recorded in the audit log");
  }
  return value;
}

/**
 * A body as the platform reads it: every figure a decimal string. A number with a fraction is
 * refused (it has already been rounded); a whole number, a string and the rest go as given.
 */
export function wire(name: string, value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) decimal(name, value);
    return value;
  }
  if (Array.isArray(value)) return value.map((each, i) => wire(`${name}[${i}]`, each));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [key, wire(`${name}.${key}`, each)]),
    );
  }
  return value;
}

/** An order's figures, checked as decimals: volume always, price and stops when given. */
function orderOf(order: RiskProposedOrder): RiskProposedOrder {
  const out: Record<string, unknown> = { ...order, volume: decimal("order.volume", order.volume) };
  for (const key of ["price", "sl", "tp"] as const) {
    const value = order[key];
    if (value !== undefined && value !== null) out[key] = decimal(`order.${key}`, value);
  }
  return out as RiskProposedOrder;
}

/** Risk Management. Every route needs Risk Management in the tenant's plan. */
export class Risk {
  readonly #client: MfxClient;

  constructor(client: MfxClient) {
    this.#client = client;
  }

  async #read<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    return (await this.#client.read({
      method: "GET",
      path,
      ...(query === undefined ? {} : { query: query as never }),
    })) as T;
  }

  async #write<T>(
    method: "POST" | "DELETE",
    path: string,
    key: unknown,
    body?: unknown,
  ): Promise<T> {
    return (await this.#client.write({
      method,
      path,
      idempotencyKey: idempotencyKey(key),
      ...(body === undefined ? {} : { body }),
    })) as T;
  }

  // ------------------------------------------------------------------------------------ policies

  /** A new policy at version 1. It protects nothing until it is activated on accounts. */
  async createPolicy(
    name: string,
    rules: RiskRules,
    options: { readonly reset: S["RiskReset"]; readonly idempotencyKey: string },
  ): Promise<RiskPolicy> {
    const body = wire("body", { name, rules, reset: options.reset });
    return this.#write("POST", "/risk/policies", options.idempotencyKey, body);
  }

  /**
   * A new version of the policy. One that relaxes protection needs `risk:override` and a
   * `reason` (`RiskOverrideRequiredError` otherwise).
   */
  async addPolicyVersion(
    policyId: string,
    rules: RiskRules,
    options: {
      readonly reset: S["RiskReset"];
      readonly reason?: string;
      readonly idempotencyKey: string;
    },
  ): Promise<RiskPolicyVersion> {
    const id = uuid("policyId", policyId);
    const body = wire("body", {
      rules,
      reset: options.reset,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
    return this.#write("POST", `/risk/policies/${id}/versions`, options.idempotencyKey, body);
  }

  /** Put a version in force on accounts; each account's outcome separately. */
  async activate(
    policyId: string,
    accountIds: readonly string[],
    options: {
      readonly version: number;
      readonly reason?: string;
      readonly idempotencyKey: string;
    },
  ): Promise<RiskActivationResult> {
    const id = uuid("policyId", policyId);
    if (!Number.isInteger(options.version) || options.version < 1) {
      throw new RangeError("version is a policy version, 1 or more");
    }
    const body = {
      account_ids: accountIds.map((a) => uuid("accountIds", a)),
      version: options.version,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    };
    return this.#write("POST", `/risk/policies/${id}/activate`, options.idempotencyKey, body);
  }

  /** A policy, its current version and the accounts it is on. */
  async policy(policyId: string): Promise<RiskPolicy> {
    return this.#read(`/risk/policies/${uuid("policyId", policyId)}`);
  }

  /** One version of a policy. */
  async policyVersion(policyId: string, version: number): Promise<RiskPolicyVersion> {
    return this.#read(`/risk/policies/${uuid("policyId", policyId)}/versions/${version}`);
  }

  /** One page of policies, newest first (or `sort: "oldest"`). */
  async policiesPage(
    options: Paged & { readonly state?: "active" | "archived"; readonly sort?: TimeSort } = {},
  ): Promise<Page<RiskPolicy>> {
    const body = await this.#read("/risk/policies", {
      cursor: options.cursor,
      limit: pageLimit(options.limit),
      state: options.state,
      sort: options.sort,
    });
    return pageOf<RiskPolicy>(body);
  }

  /** Every policy, following the cursor. */
  policies(
    options: { readonly state?: "active" | "archived"; readonly sort?: TimeSort } = {},
  ): AsyncGenerator<RiskPolicy, void, undefined> {
    return everyItem((cursor) =>
      this.policiesPage({ ...options, ...(cursor === undefined ? {} : { cursor }) }),
    );
  }

  /** Every version of a policy, newest first. */
  policyVersions(policyId: string): AsyncGenerator<RiskPolicyVersion, void, undefined> {
    const id = uuid("policyId", policyId);
    return everyItem(async (cursor) =>
      pageOf<RiskPolicyVersion>(await this.#read(`/risk/policies/${id}/versions`, { cursor })),
    );
  }

  // ------------------------------------------------------------------------------------ accounts

  /** One page of accounts with their figures, and `stats` over the whole set. */
  async accountsPage(options: AccountListOptions = {}): Promise<RiskAccountPage> {
    return this.#read("/risk/accounts", {
      cursor: options.cursor,
      limit: pageLimit(options.limit),
      coverage: many("coverage", options.coverage),
      restriction: many("restriction", options.restriction),
      sort: options.sort,
    });
  }

  /** Every account, in the order `sort` names, following the cursor. */
  accounts(
    options: Omit<AccountListOptions, "cursor"> = {},
  ): AsyncGenerator<RiskAccount, void, undefined> {
    return everyItem(async (cursor) =>
      pageOf<RiskAccount>(
        await this.accountsPage({ ...options, ...(cursor === undefined ? {} : { cursor }) }),
      ),
    );
  }

  /** One account's figures, each with its inputs and their times. */
  async account(accountId: string): Promise<RiskAccount> {
    return this.#read(`/risk/accounts/${uuid("accountId", accountId)}`);
  }

  /** The account's equity and balance from its stored reads, between two moments. */
  async equity(accountId: string, from: Date, to?: Date): Promise<RiskEquitySeries> {
    return this.#read(`/risk/accounts/${uuid("accountId", accountId)}/equity`, {
      from: from.toISOString(),
      to: to?.toISOString(),
    });
  }

  /**
   * The positions a `close_positions` action would close now: only those MFX Hub placed
   * (`mfx_positions`), or every one (`all_positions`).
   */
  async closeScope(accountId: string, scope: CloseScope): Promise<RiskCloseScope> {
    return this.#read(`/risk/accounts/${uuid("accountId", accountId)}/close-scope`, { scope });
  }

  /** End the account's activation (`risk:override`): no rule applies after it. */
  async deactivate(accountId: string, options: Reasoned): Promise<unknown> {
    const id = uuid("accountId", accountId);
    const body = { reason: reasonOf(options.reason) };
    return this.#write("POST", `/risk/accounts/${id}/deactivate`, options.idempotencyKey, body);
  }

  /** Clear a breach, or lift a restriction before it clears itself (`risk:override`). */
  async clear(
    accountId: string,
    rule: "daily_loss" | "drawdown" | "restriction",
    options: Reasoned,
  ): Promise<unknown> {
    const id = uuid("accountId", accountId);
    const body = { rule, reason: reasonOf(options.reason) };
    return this.#write("POST", `/risk/accounts/${id}/clear`, options.idempotencyKey, body);
  }

  /** Coverage by kind and state, and every account where it is not healthy. */
  async coverage(): Promise<RiskCoverageSummary> {
    return this.#read("/risk/coverage");
  }

  // -------------------------------------------------------------------------------- the planner

  /** Size a trade from a risk budget and check every rule. Nothing is sent to the broker. */
  async preview(request: RiskPreviewRequest): Promise<RiskPreview> {
    const body = wire("request", request);
    return (await this.#client.read({
      method: "POST",
      path: "/risk/planner/preview",
      body,
    })) as RiskPreview;
  }

  /** Check an order already sized, exactly as the pre-trade check would. */
  async check(accountId: string, order: RiskProposedOrder): Promise<RiskCheckResult> {
    const body = { account_id: uuid("accountId", accountId), order: orderOf(order) };
    return (await this.#client.read({
      method: "POST",
      path: "/risk/planner/check",
      body,
    })) as RiskCheckResult;
  }

  // ---------------------------------------------------------------------------------- exit plans

  /** An exit plan on a held position (`ticket`) or placed with its order (`order`). */
  async createPlan(
    plan: RiskPlanCreate,
    options: { readonly idempotencyKey: string },
  ): Promise<RiskPlan> {
    const body = wire("plan", { ...plan, ...(plan.order ? { order: orderOf(plan.order) } : {}) });
    return this.#write("POST", "/risk/plans", options.idempotencyKey, body);
  }

  /** An exit plan, each step with its holder, state and outcome, and `r_now`. */
  async plan(planId: string): Promise<RiskPlan> {
    return this.#read(`/risk/plans/${uuid("planId", planId)}`);
  }

  /** One page of plans, with `stats` over the filtered set. */
  async plansPage(options: PlanListOptions = {}): Promise<RiskPlanPage> {
    return this.#read("/risk/plans", {
      cursor: options.cursor,
      limit: pageLimit(options.limit),
      account_id: ids("accountId", options.accountId),
      state: many("state", options.state),
      sort: options.sort,
    });
  }

  /** Every plan, following the cursor. */
  plans(options: Omit<PlanListOptions, "cursor"> = {}): AsyncGenerator<RiskPlan, void, undefined> {
    return everyItem(async (cursor) =>
      pageOf<RiskPlan>(
        await this.plansPage({ ...options, ...(cursor === undefined ? {} : { cursor }) }),
      ),
    );
  }

  /** A new version of the plan's steps. */
  async amendPlan(
    planId: string,
    steps: readonly RiskPlanStepSpec[],
    options: { readonly reason?: string; readonly idempotencyKey: string },
  ): Promise<RiskPlan> {
    const id = uuid("planId", planId);
    const body = wire("body", {
      steps,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
    return this.#write("POST", `/risk/plans/${id}/amend`, options.idempotencyKey, body);
  }

  /** Pause the plan's MFX-held steps; stops held at the broker stay where they are. */
  async pausePlan(planId: string, options: Reasoned): Promise<RiskPlan> {
    const id = uuid("planId", planId);
    const body = { reason: reasonOf(options.reason) };
    return this.#write("POST", `/risk/plans/${id}/pause`, options.idempotencyKey, body);
  }

  /** Resume the plan's MFX-held steps. */
  async resumePlan(
    planId: string,
    options: { readonly idempotencyKey: string },
  ): Promise<RiskPlan> {
    const id = uuid("planId", planId);
    return this.#write("POST", `/risk/plans/${id}/resume`, options.idempotencyKey);
  }

  /** End the plan; stops held at the broker stay where they are. */
  async endPlan(planId: string, options: { readonly idempotencyKey: string }): Promise<RiskPlan> {
    const id = uuid("planId", planId);
    return this.#write("DELETE", `/risk/plans/${id}`, options.idempotencyKey);
  }

  // ---------------------------------------------------------------------------------- challenges

  /** A challenge at version 1: one rule set over many accounts. */
  async createChallenge(
    name: string,
    rules: RiskChallengeRules,
    options: { readonly idempotencyKey: string },
  ): Promise<RiskChallenge> {
    const body = wire("body", { name, rules });
    return this.#write("POST", "/risk/challenges", options.idempotencyKey, body);
  }

  /** A new version, for accounts enrolled after it; one already running keeps its own. */
  async addChallengeVersion(
    challengeId: string,
    rules: RiskChallengeRules,
    options: { readonly idempotencyKey: string },
  ): Promise<RiskChallenge> {
    const id = uuid("challengeId", challengeId);
    return this.#write(
      "POST",
      `/risk/challenges/${id}/versions`,
      options.idempotencyKey,
      wire("rules", rules),
    );
  }

  /** A challenge, its current rule set and its counts. */
  async challenge(challengeId: string): Promise<RiskChallenge> {
    return this.#read(`/risk/challenges/${uuid("challengeId", challengeId)}`);
  }

  /** Every challenge, newest first, each with its counts. */
  challenges(): AsyncGenerator<RiskChallenge, void, undefined> {
    return everyItem(async (cursor) =>
      pageOf<RiskChallenge>(await this.#read("/risk/challenges", { cursor })),
    );
  }

  /**
   * Enrol accounts in the challenge's current version; each account's outcome separately (one
   * with a stale read is refused `risk_inputs_stale`).
   */
  async enrol(
    challengeId: string,
    accountIds: readonly string[],
    options: { readonly idempotencyKey: string },
  ): Promise<unknown> {
    const id = uuid("challengeId", challengeId);
    const body = { account_ids: accountIds.map((a) => uuid("accountIds", a)) };
    return this.#write("POST", `/risk/challenges/${id}/accounts`, options.idempotencyKey, body);
  }

  /** One page of the challenge's accounts, with `stats`. This list, paged, is the export. */
  async challengeAccountsPage(
    challengeId: string,
    options: ChallengeAccountListOptions = {},
  ): Promise<RiskChallengeAccountPage> {
    return this.#read(`/risk/challenges/${uuid("challengeId", challengeId)}/accounts`, {
      cursor: options.cursor,
      limit: pageLimit(options.limit),
      state: many("state", options.state),
      rule: many("rule", options.rule),
      below_min_days: options.belowMinDays,
      sort: options.sort,
    });
  }

  /** Every account of the challenge, in the order `sort` names. */
  challengeAccounts(
    challengeId: string,
    options: Omit<ChallengeAccountListOptions, "cursor"> = {},
  ): AsyncGenerator<RiskChallengeAccount, void, undefined> {
    return everyItem(async (cursor) =>
      pageOf<RiskChallengeAccount>(
        await this.challengeAccountsPage(challengeId, {
          ...options,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      ),
    );
  }

  /** One enrolled account, its result and its periods with their statistics. */
  async challengeAccount(
    challengeId: string,
    accountId: string,
  ): Promise<RiskChallengeAccountDetail> {
    const id = uuid("challengeId", challengeId);
    return this.#read(`/risk/challenges/${id}/accounts/${uuid("accountId", accountId)}`);
  }

  // ------------------------------------------------------------------------------------ activity

  /** One page of activity, unresolved first by default, with `stats`. */
  async activityPage(options: ActivityListOptions = {}): Promise<RiskActivityPage> {
    return this.#read("/risk/activity", {
      cursor: options.cursor,
      limit: pageLimit(options.limit),
      kind: many("kind", options.kind),
      account_id: ids("accountId", options.accountId),
      outcome: many("outcome", options.outcome),
      from: options.from?.toISOString(),
      to: options.to?.toISOString(),
      sort: options.sort,
    });
  }

  /** Every warning, breach, action and change, following the cursor. */
  activity(
    options: Omit<ActivityListOptions, "cursor"> = {},
  ): AsyncGenerator<RiskActivity, void, undefined> {
    return everyItem(async (cursor) =>
      pageOf<RiskActivity>(
        await this.activityPage({ ...options, ...(cursor === undefined ? {} : { cursor }) }),
      ),
    );
  }
}
