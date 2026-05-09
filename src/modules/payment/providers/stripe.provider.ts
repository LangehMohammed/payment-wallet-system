import { Injectable, Logger } from '@nestjs/common';
import { TransactionType } from '@prisma/client';
import {
  IPaymentProvider,
  DepositIntentResult,
} from './interface/payment-provider.interface';
import { ProviderResult } from '../dto/provider-result.dto';
import { ProviderConfigService } from './config/provider-config.service';
import Stripe from 'stripe';

/**
 * Stripe payment provider adapter.
 *
 * ## Deposit Flow (Stripe Financial Connections + ACH Direct Debit)
 * 1. createDepositIntent() → stripe.paymentIntents.create({ payment_method_types: ['us_bank_account'] })
 *    Returns client_secret for frontend stripe.confirmUsBankAccountPayment()
 * 2. Frontend: User authenticates bank via Financial Connections modal
 * 3. confirmDeposit() → stripe.paymentIntents.retrieve() to verify status
 *    Returns success if status === 'succeeded'
 *
 * ## Payout Flow (Stripe Connect Express + Instant Payouts)
 * 1. createPayout() → stripe.payouts.create({ amount, currency, destination: connectedAccountId })
 *    Requires merchant to have Stripe Connect Express account linked
 *
 * ## Error contract
 * All methods MUST NOT throw. Errors are caught and returned as
 * { success: false, errorMessage, rawResponse }.
 */
@Injectable()
export class StripeProvider implements IPaymentProvider {
  private readonly stripe: Stripe.Stripe;
  private readonly logger = new Logger(StripeProvider.name);

  constructor(private readonly configService: ProviderConfigService) {
    const config = this.configService.StripeConfig;
    if (!config) {
      this.logger.warn(
        'STRIPE_SECRET_KEY not configured — Stripe provider will fail on calls',
      );
    }

    // Initialize Stripe SDK with API version pinned for stability
    this.stripe = new Stripe(config.secretKey, {
      apiVersion: '2026-04-22.dahlia',
      typescript: true,
    });
  }

  // ── Deposit Intent ─────────────────────────────────────────────────────────

  /**
   * Creates a Stripe PaymentIntent for ACH bank account deposit.
   *
   * Expected payload:
   *   { userId, walletId, amount, currency }
   *
   * SDK call:
   *   const intent = await stripe.paymentIntents.create({
   *     amount: amount * 100, // Stripe uses cents
   *     currency: currency,
   *     payment_method_types: ['us_bank_account'],
   *     metadata: { userId, walletId }
   *   });
   */
  async createDepositIntent(
    payload: Record<string, unknown>,
  ): Promise<DepositIntentResult> {
    try {
      const amount = Number(payload['amount']);
      const currency = String(payload['currency']).toLowerCase();
      const userId = String(payload['userId']);
      const walletId = String(payload['walletId']);

      this.logger.log('Creating Stripe PaymentIntent for ACH deposit', {
        amount,
        currency,
        userId,
      });

      const intent = await this.stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency,
        payment_method_types: ['us_bank_account'],
        metadata: {
          userId,
          walletId,
          source: 'wallet_deposit',
        },
      });

      this.logger.log('Stripe PaymentIntent created successfully', {
        intentId: intent.id,
        status: intent.status,
      });

      return {
        success: true,
        clientSecret: intent.client_secret!,
        intentId: intent.id,
        rawResponse: {
          id: intent.id,
          client_secret: intent.client_secret,
          amount: intent.amount,
          currency: intent.currency,
          status: intent.status,
        },
      };
    } catch (error) {
      this.logger.error('Stripe createDepositIntent failed', {
        error: error instanceof Error ? error.message : String(error),
        payload,
      });

      return {
        success: false,
        errorMessage:
          error instanceof Stripe.errors.StripeError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Unexpected Stripe error',
        rawResponse: {
          error:
            error instanceof Stripe.errors.StripeError
              ? error.raw
              : String(error),
        },
      };
    }
  }

  // ── Deposit Confirmation ───────────────────────────────────────────────────

  /**
   * Confirms a deposit by verifying the PaymentIntent status.
   *
   * Expected payload:
   *   { paymentIntentId, userId }
   *
   * SDK call:
   *   const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
   *   if (intent.status === 'succeeded') { success }
   */
  async confirmDeposit(
    payload: Record<string, unknown>,
  ): Promise<ProviderResult> {
    try {
      const paymentIntentId = String(payload['paymentIntentId']);

      this.logger.log('Confirming Stripe PaymentIntent', { paymentIntentId });

      const intent = await this.stripe.paymentIntents.retrieve(paymentIntentId);

      this.logger.log('Stripe PaymentIntent retrieved', {
        intentId: intent.id,
        status: intent.status,
      });

      // Check if payment succeeded
      if (intent.status === 'succeeded') {
        return {
          success: true,
          providerRef: intent.id,
          rawResponse: {
            id: intent.id,
            status: intent.status,
            amount: intent.amount,
            currency: intent.currency,
            payment_method: intent.payment_method,
          },
        };
      }

      // Payment not succeeded — treat as failure
      return {
        success: false,
        errorMessage: `PaymentIntent status is "${intent.status}" (expected "succeeded")`,
        rawResponse: {
          id: intent.id,
          status: intent.status,
          amount: intent.amount,
          currency: intent.currency,
        },
      };
    } catch (error) {
      this.logger.error('Stripe confirmDeposit failed', {
        error: error instanceof Error ? error.message : String(error),
        payload,
      });

      return {
        success: false,
        errorMessage:
          error instanceof Stripe.errors.StripeError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Unexpected Stripe error',
        rawResponse: {
          error:
            error instanceof Stripe.errors.StripeError
              ? error.raw
              : String(error),
        },
      };
    }
  }

  // ── Payout ─────────────────────────────────────────────────────────────────

  /**
   * Creates a payout to an external Stripe Connect Express account.
   *
   * Expected payload:
   *   { userId, amount, currency, stripeConnectedAccountId }
   *
   * SDK call:
   *   const payout = await stripe.payouts.create({
   *     amount: amount * 100,
   *     currency: currency,
   *     destination: stripeConnectedAccountId,
   *     metadata: { userId }
   *   });
   */
  async createPayout(
    payload: Record<string, unknown>,
  ): Promise<ProviderResult> {
    try {
      const amount = Number(payload['amount']);
      const currency = String(payload['currency']).toLowerCase();
      const userId = String(payload['userId']);
      const stripeConnectedAccountId = String(
        payload['stripeConnectedAccountId'],
      );

      this.logger.log('Creating Stripe payout', {
        amount,
        currency,
        userId,
        destination: stripeConnectedAccountId,
      });

      const payout = await this.stripe.payouts.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency,
        destination: stripeConnectedAccountId,
        metadata: {
          userId,
          source: 'wallet_withdrawal',
        },
      });

      this.logger.log('Stripe payout created successfully', {
        payoutId: payout.id,
        status: payout.status,
      });

      return {
        success: true,
        providerRef: payout.id,
        rawResponse: {
          id: payout.id,
          status: payout.status,
          amount: payout.amount,
          currency: payout.currency,
          arrival_date: payout.arrival_date,
        },
      };
    } catch (error) {
      this.logger.error('Stripe createPayout failed', {
        error: error instanceof Error ? error.message : String(error),
        payload,
      });

      return {
        success: false,
        errorMessage:
          error instanceof Stripe.errors.StripeError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Unexpected Stripe error',
        rawResponse: {
          error:
            error instanceof Stripe.errors.StripeError
              ? error.raw
              : String(error),
        },
      };
    }
  }

  // ── Unified Process (Backwards Compatibility) ──────────────────────────────

  /**
   * Routes to confirmDeposit() or createPayout() based on transaction type.
   * Used by the outbox processor.
   */
  async process(
    payload: Record<string, unknown>,
    transactionType: TransactionType,
  ): Promise<ProviderResult> {
    if (transactionType === TransactionType.DEPOSIT) {
      return this.confirmDeposit(payload);
    } else if (transactionType === TransactionType.WITHDRAWAL) {
      return this.createPayout(payload);
    } else {
      this.logger.error('Unsupported transaction type', { transactionType });
      return {
        success: false,
        errorMessage: `Unsupported transaction type: ${transactionType}`,
        rawResponse: { transactionType },
      };
    }
  }
}
