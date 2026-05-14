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
 * 3. Processor calls confirmDeposit() → transitions PaymentIntent to processing state
 *    Returns requiresWebhook: true — ACH settlement is async (1-4 business days)
 * 4. Webhook receives payment_intent.succeeded / payment_intent.payment_failed → settles
 *
 * ## Payout Flow (Stripe Connect Express + Instant Payouts)
 * 1. Processor calls createPayout() → stripe.payouts.create()
 *    Returns requiresWebhook: true — payout delivery is async
 * 2. Webhook receives payout.paid / payout.failed → settles
 *
 * ## requiresWebhook contract
 * Both methods return requiresWebhook: true because Stripe settlement is always
 * asynchronous. The processor marks the outbox event delivered and exits.
 * The webhook module drives all balance mutations.
 *
 * Exception: if the provider call itself fails (network error, invalid params),
 * success: false is returned without requiresWebhook — the processor calls .fail().
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
        amount: Math.round(amount * 100),
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
   * Confirms a Stripe ACH deposit by verifying the PaymentIntent can proceed.
   *
   * Expected payload:
   *   { paymentIntentId, userId }
   */
  async confirmDeposit(
    payload: Record<string, unknown>,
  ): Promise<ProviderResult> {
    try {
      const paymentIntentId = String(payload['paymentIntentId']);

      this.logger.log('Confirming Stripe PaymentIntent (ACH — async)', {
        paymentIntentId,
      });

      const intent = await this.stripe.paymentIntents.retrieve(paymentIntentId);

      this.logger.log('Stripe PaymentIntent retrieved', {
        intentId: intent.id,
        status: intent.status,
      });

      if (
        intent.status === 'canceled' ||
        intent.status === 'requires_payment_method'
      ) {
        return {
          success: false,
          errorMessage: `PaymentIntent is in terminal failure state: "${intent.status}"`,
          rawResponse: {
            id: intent.id,
            status: intent.status,
            amount: intent.amount,
            currency: intent.currency,
          },
        };
      }

      return {
        success: true,
        requiresWebhook: true,
        providerRef: intent.id,
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
        amount: Math.round(amount * 100),
        currency,
        destination: stripeConnectedAccountId,
        metadata: {
          userId,
          source: 'wallet_withdrawal',
        },
      });

      this.logger.log('Stripe payout created — awaiting webhook confirmation', {
        payoutId: payout.id,
        status: payout.status,
      });

      return {
        success: true,
        requiresWebhook: true,
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

  // ── Unified Process ────────────────────────────────────────────────────────

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
