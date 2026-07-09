import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma/prisma.service';

export interface ConnectAccountRecord {
  id: string;
  stripeConnectAccountId: string | null;
}

@Injectable()
export class StripeConnectRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * Returns the user's ID and stripeConnectAccountId only.
   * Intentionally narrow — this repository owns nothing beyond the Connect field.
   */
  async findById(userId: string): Promise<ConnectAccountRecord | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, stripeConnectAccountId: true },
    });
  }

  /**
   * Looks up a user by their Stripe Connect account ID.
   * Used by the webhook handler to map Stripe events back to internal users.
   */
  async findByConnectAccountId(
    stripeConnectAccountId: string,
  ): Promise<ConnectAccountRecord | null> {
    return this.prisma.user.findUnique({
      where: { stripeConnectAccountId },
      select: { id: true, stripeConnectAccountId: true },
    });
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /**
   * Persists the Stripe Connect account ID against the user.
   *
   * Called immediately after stripe.accounts.create() succeeds — before the
   * user completes onboarding — so that webhook events carrying the account ID
   * can be reconciled back to the internal user record.
   *
   * Idempotent: if the user already has this exact account ID stored, the
   * update is a no-op at the DB level (same value written).
   */
  async setConnectAccountId(
    userId: string,
    stripeConnectAccountId: string,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { stripeConnectAccountId },
      select: { id: true },
    });
  }

  /**
   * Clears the Connect account ID when an account is deauthorized.
   * Called by the webhook handler on `account.application.deauthorized`.
   */
  async clearConnectAccountId(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { stripeConnectAccountId: null },
      select: { id: true },
    });
  }
}
