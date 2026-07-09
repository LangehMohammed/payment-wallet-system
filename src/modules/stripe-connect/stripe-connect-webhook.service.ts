import { Injectable, Logger } from '@nestjs/common';
import { AuditLogger } from '@app/common/audit/audit-logger.service';
import { StripeConnectRepository } from './stripe-connect.repository';
import { StripeConnectClient } from './stripe-connect.client';


type StripeEvent = ReturnType<StripeConnectClient['constructWebhookEvent']>;

/**
 * Handles the business logic for each Stripe Connect webhook event type.
 *
 * ## Responsibility boundary
 * This service knows nothing about HTTP. It receives already-verified,
 * already-parsed Stripe event objects from the webhook controller.
 * Verification (signature check) lives in the controller.
 *
 * ## Event handling contract
 * - Every public method is fire-and-forget safe: they log errors but do NOT
 *   throw. The controller must return 200 to Stripe regardless of whether our
 *   internal processing succeeded — Stripe retries on non-2xx, which would
 *   cause duplicate processing and audit noise.
 * - If a handler has a side effect that must be durable (e.g. clearing the
 *   account ID), it awaits the DB call. Failure is logged and swallowed.
 *
 * ## Handled events
 *   account.updated                  → derive and audit onboarding completion
 *   account.application.deauthorized → clear stripeConnectAccountId, audit
 *   capability.updated               → log capability state changes
 *
 * All other events are acknowledged by the controller without reaching here.
 */
@Injectable()
export class StripeConnectWebhookService {
  private readonly logger = new Logger(StripeConnectWebhookService.name);

  constructor(
    private readonly stripeConnectRepository: StripeConnectRepository,
    private readonly audit: AuditLogger,
  ) {}

  // ── account.updated ────────────────────────────────────────────────────────

  /**
   * Fires whenever Stripe updates the state of a Connect account — including
   * when verification completes and `charges_enabled` / `payouts_enabled` flip.
   *
   * We use this to detect onboarding completion: the moment both flags become
   * true is the authoritative signal that the account is ready for payouts.
   * The `GET /onboarding/return` redirect is NOT the source of truth — it fires
   * even when the user exits onboarding early without completing it.
   *
   * ## User resolution
   * Stripe sends the account ID in `event.account` (the connected account).
   * We look up the internal user by `stripeConnectAccountId` to get `userId`
   * for the audit log. If not found, we log a warning (the account may have
   * been created outside our system) and return early.
   *
   * ## Type cast on event.data.object
   * `event.data.object` is typed as `object` by the SDK — a deliberate wide
   * type since the shape depends on the event type. We cast to `Record<string,
   * unknown>` and access only fields we explicitly log. The `account.updated`
   * contract guarantees these fields are present; the cast is safe within this
   * event handler.
   */
  async handleAccountUpdated(event: StripeEvent): Promise<void> {
    const obj = event.data.object as unknown as Record<string, unknown>;
    const accountId = obj['id'] as string;
    const chargesEnabled = obj['charges_enabled'] as boolean;
    const payoutsEnabled = obj['payouts_enabled'] as boolean;
    const detailsSubmitted = obj['details_submitted'] as boolean;

    this.logger.log('account.updated received', {
      accountId,
      chargesEnabled,
      payoutsEnabled,
      detailsSubmitted,
    });

    const user =
      await this.stripeConnectRepository.findByConnectAccountId(accountId);

    if (!user) {
      this.logger.warn(
        'account.updated received for unknown Connect account — skipping',
        { accountId },
      );
      return;
    }

    // Onboarding is complete when Stripe enables both charges and payouts.
    // We audit this transition once — repeated `account.updated` events after
    // completion are logged but do not re-emit the audit event.
    if (chargesEnabled && payoutsEnabled) {
      void this.audit.log('STRIPE_CONNECT_ONBOARDING_COMPLETED', {
        userId: user.id,
        meta: { accountId, chargesEnabled, payoutsEnabled },
      });

      this.logger.log('Stripe Connect onboarding completed', {
        userId: user.id,
        accountId,
      });
    }
  }

  // ── account.application.deauthorized ──────────────────────────────────────

  /**
   * Fires when a connected account disconnects from our platform via the
   * Stripe dashboard or `stripe.oauth.deauthorize()`.
   *
   * Action: clear `stripeConnectAccountId` from the User record so the user
   * can re-onboard if needed, and block any in-flight payout attempts that
   * would fail with a Stripe auth error.
   *
   * ## Payout safety
   * Any INITIATED withdrawal outbox events for this user will fail at the
   * provider call stage (Stripe rejects calls for deauthorized accounts).
   * The outbox processor's retry + fail path handles that correctly —
   * no special handling needed here.
   */
  async handleAccountDeauthorized(event: StripeEvent): Promise<void> {
    // Deauthorization events carry the account ID in event.account,
    // not event.data.object (which is a DeauthorizationEvent shape).
    const accountId = event.account;

    if (!accountId) {
      this.logger.warn(
        'account.application.deauthorized received without event.account — skipping',
        { eventId: event.id },
      );
      return;
    }

    this.logger.log('account.application.deauthorized received', { accountId });

    const user =
      await this.stripeConnectRepository.findByConnectAccountId(accountId);

    if (!user) {
      this.logger.warn(
        'Deauthorized Connect account not found in DB — already cleared or unknown',
        { accountId },
      );
      return;
    }

    try {
      await this.stripeConnectRepository.clearConnectAccountId(user.id);
    } catch (error) {
      // Log and swallow — must not throw, must return 200 to Stripe.
      this.logger.error(
        'Failed to clear stripeConnectAccountId after deauthorization',
        {
          userId: user.id,
          accountId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      void this.audit.error('STRIPE_CONNECT_ACCOUNT_DEAUTHORIZED', {
        userId: user.id,
        meta: { accountId, cleared: false, error: 'db_write_failed' },
      });
      return;
    }

    void this.audit.warn('STRIPE_CONNECT_ACCOUNT_DEAUTHORIZED', {
      userId: user.id,
      meta: { accountId, cleared: true },
    });

    this.logger.log(
      'Stripe Connect account deauthorized — account ID cleared',
      {
        userId: user.id,
        accountId,
      },
    );
  }

  // ── capability.updated ─────────────────────────────────────────────────────

  /**
   * Fires when a capability (e.g. `transfers`, `card_payments`) changes state.
   * We observe but do not mutate state here — `account.updated` is the
   * authoritative event for onboarding completion. This handler exists
   * purely for operational visibility.
   */
  handleCapabilityUpdated(event: StripeEvent): void {
    const obj = event.data.object as unknown as Record<string, unknown>;

    this.logger.log('capability.updated received', {
      accountId: event.account,
      capabilityId: obj['id'],
      status: obj['status'],
    });
  }
}
