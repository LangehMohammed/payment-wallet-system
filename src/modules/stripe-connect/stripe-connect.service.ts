import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditLogger } from '@app/common/audit/audit-logger.service';
import { StripeConnectClient } from './stripe-connect.client';
import { StripeConnectRepository } from './stripe-connect.repository';
import {
  ConnectAccountStatusDto,
  CreateConnectAccountResponseDto,
  RefreshOnboardingLinkResponseDto,
} from './dto/stripe-connect.dto';

@Injectable()
export class StripeConnectService {
  private readonly logger = new Logger(StripeConnectService.name);

  constructor(
    private readonly stripeConnectClient: StripeConnectClient,
    private readonly stripeConnectRepository: StripeConnectRepository,
    private readonly configService: ConfigService,
    private readonly audit: AuditLogger,
  ) {}

  // ── Onboarding ─────────────────────────────────────────────────────────────

  /**
   * Creates a Stripe Connect Express account for the user and returns the
   * Stripe-hosted onboarding URL.
   *
   * ## Idempotency
   * If the user already has a Connect account ID stored, we skip creation and
   * generate a fresh account link for the existing account. This handles the
   * case where a user starts onboarding, abandons it, and restarts — Stripe
   * account IDs are permanent and must not be duplicated per user.
   *
   * ## Persistence timing
   * The account ID is written to the DB immediately after `stripe.accounts.create()`
   * succeeds, BEFORE the onboarding link is generated. This ensures that if
   * account link generation fails, the account ID is still persisted and the
   * user can call this endpoint again to get a fresh link (idempotent path above).
   *
   * ## Failure modes
   * - Stripe SDK throws → caught, re-thrown as BadGatewayException (provider fault)
   * - DB write fails after account creation → the Stripe account exists but is
   *   unlinked. The error propagates; the user retries. Because we query Stripe
   *   by email we cannot auto-recover the orphaned account — operators must
   *   reconcile manually via the Stripe dashboard. This is an acceptable rare
   *   edge case given the transaction boundary constraints.
   */
  async createConnectAccount(
    userId: string,
    userEmail: string,
  ): Promise<CreateConnectAccountResponseDto> {
    const user = await this.stripeConnectRepository.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    let accountId = user.stripeConnectAccountId;

    if (!accountId) {
      accountId = await this.createAndPersistAccount(userId, userEmail);
    } else {
      this.logger.log(
        'User already has a Connect account — generating fresh onboarding link',
        { userId, accountId },
      );
    }

    const onboardingUrl = await this.generateOnboardingLink(accountId);

    void this.audit.log('STRIPE_CONNECT_ACCOUNT_CREATED', {
      userId,
      meta: { accountId },
    });

    return { accountId, onboardingUrl };
  }

  /**
   * Returns the current state of the user's Stripe Connect account.
   * Derives `onboardingState` from Stripe's `charges_enabled`,
   * `payouts_enabled`, and `requirements` fields.
   *
   * Returns a `not_connected` stub (no Stripe call) when no account is linked —
   * avoids an unnecessary round-trip and a confusing 404 from Stripe.
   */
  async getAccountStatus(userId: string): Promise<ConnectAccountStatusDto> {
    const user = await this.stripeConnectRepository.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    if (!user.stripeConnectAccountId) {
      return {
        accountId: null,
        chargesEnabled: false,
        payoutsEnabled: false,
        onboardingState: 'not_connected',
      };
    }

    // Use .catch() so TypeScript infers the type of `account` from the resolved
    // value of retrieveAccount() without requiring an explicit Stripe.Account
    // annotation. The Stripe SDK v22 CJS type declarations do not re-export
    // resource types on the StripeConstructor namespace, making Stripe.Account
    // unavailable via any top-level import style.
    const account = await this.stripeConnectClient
      .retrieveAccount(user.stripeConnectAccountId)
      .catch((error) => {
        this.logger.error('Failed to retrieve Stripe Connect account', {
          userId,
          accountId: user.stripeConnectAccountId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new BadGatewayException(
          'Unable to retrieve account status from Stripe. Please try again.',
        );
      });

    return {
      accountId: account.id,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      onboardingState: this.deriveOnboardingState(account),
    };
  }

  /**
   * Generates a fresh onboarding link for a user's existing Connect account.
   *
   * Called when the original link has expired (Stripe redirects to `refreshUrl`
   * which hits `GET /stripe-connect/onboarding/refresh`).
   *
   * Throws if the user has no linked account — callers must hit
   * `POST /stripe-connect/accounts` first.
   */
  async refreshOnboardingLink(
    userId: string,
  ): Promise<RefreshOnboardingLinkResponseDto> {
    const user = await this.stripeConnectRepository.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    if (!user.stripeConnectAccountId) {
      throw new BadRequestException(
        'No Stripe Connect account found. Call POST /stripe-connect/accounts first.',
      );
    }

    const onboardingUrl = await this.generateOnboardingLink(
      user.stripeConnectAccountId,
    );

    return { onboardingUrl };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Creates the Stripe account and immediately persists the ID to the DB.
   * Extracted so the caller (createConnectAccount) stays readable.
   */
  private async createAndPersistAccount(
    userId: string,
    userEmail: string,
  ): Promise<string> {
    // const inferred from resolved Promise — no Stripe.Account annotation needed
    const account = await this.stripeConnectClient
      .createAccount(userEmail)
      .catch((error) => {
        this.logger.error('Stripe account creation failed', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new BadGatewayException(
          'Unable to create Stripe Connect account. Please try again.',
        );
      });

    // Persist immediately — before generating the link — so that if
    // link generation fails the account ID is already stored and the
    // next call takes the idempotent path (generate link only).
    await this.stripeConnectRepository.setConnectAccountId(userId, account.id);

    this.logger.log('Stripe Connect account created and persisted', {
      userId,
      accountId: account.id,
    });

    return account.id;
  }

  /**
   * Calls Stripe to generate an account link (onboarding URL).
   * Throws BadGatewayException if the Stripe call fails.
   */
  private async generateOnboardingLink(accountId: string): Promise<string> {
    const returnUrl = this.configService.get<string>(
      'stripe.connectReturnUrl',
    ) as string;
    const refreshUrl = this.configService.get<string>(
      'stripe.connectRefreshUrl',
    ) as string;

    const link = await this.stripeConnectClient
      .createAccountLink(accountId, returnUrl, refreshUrl)
      .catch((error) => {
        this.logger.error('Stripe account link generation failed', {
          accountId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new BadGatewayException(
          'Unable to generate onboarding link. Please try again.',
        );
      });

    return link.url;
  }

  /**
   * Maps Stripe account flags to a single human-readable onboarding state.
   *
   * State derivation:
   *   complete    — charges_enabled AND payouts_enabled (fully onboarded)
   *   restricted  — charges_enabled but payouts disabled (restricted mode)
   *   pending     — not yet enabled; requirements outstanding
   *
   * `details_submitted` indicates the user has gone through the Stripe flow
   * but Stripe's verification is still in progress → still `pending`.
   *
   * Parameter typed via ReturnType utility — avoids Stripe.Account annotation
   * which is inaccessible on the StripeConstructor namespace in SDK v22.
   */
  private deriveOnboardingState(
    account: Awaited<ReturnType<StripeConnectClient['retrieveAccount']>>,
  ): ConnectAccountStatusDto['onboardingState'] {
    if (account.charges_enabled && account.payouts_enabled) return 'complete';
    if (account.charges_enabled && !account.payouts_enabled)
      return 'restricted';
    return 'pending';
  }
}