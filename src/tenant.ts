// `client.tenant`: what the calling key's organisation is, as any key may read it.
//
//     const due = await client.tenant.serviceAgreement();
//     if (due.held) console.log("an owner or admin accepts at", due.accept_url);
//
// While something is due, every answer carries `MFX-Service-Agreement: due`, and the client warns
// once the first time it sees it. Once it holds, additions are refused with
// `ServiceAgreementNotAcceptedError` or `TermsNotAcceptedError` (409); nothing running ever is.

import type { MfxClient } from "./client.js";
import type { components } from "./generated/api.js";

/**
 * What the organisation must still accept before it can add anything: `due`, `held` (additions
 * are refused now), the `plan` in force, the `plan_change` awaiting acceptance (or null), each of
 * the `documents` due and the `accept_url` where an owner or admin accepts.
 */
export type TenantServiceAgreement = components["schemas"]["TenantServiceAgreement"];
/** A move from one plan to another, as the contract writes it. */
export type PlanChangeSummary = components["schemas"]["PlanChangeSummary"];

/** The calling key's organisation. Readable by any key, whatever its scopes. */
export class Tenant {
  readonly #client: MfxClient;

  constructor(client: MfxClient) {
    this.#client = client;
  }

  /** What the organisation must still accept (`GET /tenant/service-agreement`), as the API wrote it. */
  async serviceAgreement(): Promise<TenantServiceAgreement> {
    return (await this.#client.read({
      method: "GET",
      path: "/tenant/service-agreement",
    })) as TenantServiceAgreement;
  }
}
