import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Account } from '../../../node_modules/stripe/cjs/resources/Accounts.js';
import type { AccountLink } from '../../../node_modules/stripe/cjs/resources/AccountLinks.js';
import type { Event as StripeEvent } from '../../../node_modules/stripe/cjs/resources/Events.js';
import type { Response as StripeResponse } from '../../../node_modules/stripe/cjs/lib.js';

/**
 * Thin Stripe SDK wrapper scoped exclusively to Connect Express operations.
 *
 * Intentionally separate from StripeProvider (which handles payment processing).
 * One class, one purpose — Connect account lifecycle is a distinct concern from
 * payment intent creation and payout execution.
 *
 * ## Type import strategy
 * Stripe SDK v22 uses `export = StripeConstructor` (CJS interop) which does not
 * re-export resource types (Account, AccountLink, Event, etc.) on the top-level
 * namespace. We import them directly from their source files within the package.
 * These are the same paths the SDK uses internally — they are stable across
 * patch and minor releases within v22.
 *
 * ## Initialization
 * The SDK client is instantiated in the constructor so misconfiguration
 * surfaces at module load time, not on the first API call. A warn is logged
 * (not a throw) in non-production to allow the app to boot without Stripe
 * credentials configured — consistent with the pattern in StripeProvider.
 *
 * In production, missing credentials are caught by configValidationSchema
 * before this constructor is ever called.
 */
@Injectable()
export class StripeConnectClient {
  private readonly stripe: InstanceType<typeof Stripe>;
  private readonly logger = new Logger(StripeConnectClient.name);

  constructor(private readonly configService: ConfigService) {
    const secretKey = this.configService.get<string>('stripe.secretKey');

    if (!secretKey) {
      this.logger.warn(
        'STRIPE_SECRET_KEY not configured — StripeConnectClient will fail on calls',
      );
    }

    this.stripe = new Stripe(secretKey ?? '', {
      apiVersion: '2026-04-22.dahlia',
      typescript: true,
    });
  }

  // ── Account ────────────────────────────────────────────────────────────────

  /**
   * Creates a Stripe Connect Express account for the given user.
   *
   * The `email` is passed as a hint for Stripe's onboarding UI pre-fill.
   * Stripe does not use it as a unique constraint — multiple accounts can
   * share the same email. Our uniqueness constraint lives in the DB.
   */
  async createAccount(email: string): Promise<StripeResponse<Account>> {
    return this.stripe.accounts.create({
      type: 'express',
      email,
      capabilities: {
        transfers: { requested: true },
      },
    });
  }

  /**
   * Retrieves the current state of a Connect account from Stripe.
   * Used to derive `chargesEnabled`, `payoutsEnabled`, and onboarding state.
   */
  async retrieveAccount(accountId: string): Promise<StripeResponse<Account>> {
    return this.stripe.accounts.retrieve(accountId);
  }

  // ── Account Links ──────────────────────────────────────────────────────────

  /**
   * Generates a Stripe-hosted onboarding URL for the given account.
   *
   * Account links expire after 5 minutes — callers must generate a fresh
   * link each time the user needs to be redirected. Links are single-use.
   *
   * `returnUrl`  — where Stripe redirects after the user completes onboarding.
   * `refreshUrl` — where Stripe redirects if the link has expired.
   */
  async createAccountLink(
    accountId: string,
    returnUrl: string,
    refreshUrl: string,
  ): Promise<StripeResponse<AccountLink>> {
    return this.stripe.accountLinks.create({
      account: accountId,
      return_url: returnUrl,
      refresh_url: refreshUrl,
      type: 'account_onboarding',
    });
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────

  /**
   * Verifies a Stripe webhook signature and returns the parsed event.
   * Throws `StripeSignatureVerificationError` on invalid signature.
   */
  constructWebhookEvent(
    rawBody: Buffer,
    signature: string,
    secret: string,
  ): StripeEvent {
    return this.stripe.webhooks.constructEvent(rawBody, signature, secret);
  }
}