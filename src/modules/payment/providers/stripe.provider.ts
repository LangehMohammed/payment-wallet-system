import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionType } from '@prisma/client';
import {
  IPaymentProvider,
  DepositIntentResult,
} from './interface/payment-provider.interface';
import { ProviderResult } from '../dto/provider-result.dto';

/**
 * Stripe payment provider adapter.
 *
 * ## Current state (Step 1)
 * Method signatures implemented with stubs. Real Stripe SDK integration
 * happens in Steps 4-6.
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
  private readonly logger = new Logger(StripeProvider.name);

  constructor(private readonly configService: ConfigService) {}

  // ── Deposit Intent ─────────────────────────────────────────────────────────

  /**
   * Creates a Stripe PaymentIntent for ACH bank account deposit.
   *
   * Stub: Returns simulated client_secret. Real implementation in Step 5.
   *
   * Expected payload:
   *   { userId, amount, currency }
   *
   * Real SDK call (Step 5):
   *   const intent = await stripe.paymentIntents.create({
   *     amount: payload.amount * 100, // Stripe uses cents
   *     currency: payload.currency,
   *     payment_method_types: ['us_bank_account'],
   *     metadata: { userId: payload.userId }
   *   });
   *   return { success: true, clientSecret: intent.client_secret, intentId: intent.id };
   */
  async createDepositIntent(
    payload: Record<string, unknown>,
  ): Promise<DepositIntentResult> {
    try {
      this.logger.log('Stripe stub — creating deposit intent', {
        amount: payload['amount'],
        currency: payload['currency'],
      });

      const simulatedIntentId = `pi_sim_${Date.now()}`;
      const simulatedClientSecret = `${simulatedIntentId}_secret_sim`;

      return {
        success: true,
        clientSecret: simulatedClientSecret,
        intentId: simulatedIntentId,
        rawResponse: {
          id: simulatedIntentId,
          client_secret: simulatedClientSecret,
          amount: payload['amount'],
          currency: payload['currency'],
          status: 'requires_payment_method',
        },
      };
    } catch (error) {
      this.logger.error('Stripe createDepositIntent threw', { error, payload });
      return {
        success: false,
        errorMessage:
          error instanceof Error ? error.message : 'Unexpected Stripe error',
        rawResponse: { error: String(error) },
      };
    }
  }

  // ── Deposit Confirmation ───────────────────────────────────────────────────

  /**
   * Confirms a deposit by verifying the PaymentIntent status.
   *
   * Stub: Returns simulated success. Real implementation in Step 5.
   *
   * Expected payload:
   *   { paymentIntentId, userId }
   *
   * Real SDK call (Step 5):
   *   const intent = await stripe.paymentIntents.retrieve(payload.paymentIntentId);
   *   if (intent.status === 'succeeded') {
   *     return { success: true, providerRef: intent.id, rawResponse: intent };
   *   }
   *   return { success: false, errorMessage: `Status: ${intent.status}`, rawResponse: intent };
   */
  async confirmDeposit(
    payload: Record<string, unknown>,
  ): Promise<ProviderResult> {
    try {
      this.logger.log('Stripe stub — confirming deposit', {
        paymentIntentId: payload['paymentIntentId'],
      });

      const simulatedRef = `pi_confirmed_${Date.now()}`;
      return {
        success: true,
        providerRef: simulatedRef,
        rawResponse: {
          id: simulatedRef,
          status: 'succeeded',
          paymentIntentId: payload['paymentIntentId'],
        },
      };
    } catch (error) {
      this.logger.error('Stripe confirmDeposit threw', { error, payload });
      return {
        success: false,
        errorMessage:
          error instanceof Error ? error.message : 'Unexpected Stripe error',
        rawResponse: { error: String(error) },
      };
    }
  }

  // ── Payout ─────────────────────────────────────────────────────────────────

  /**
   * Creates a payout to an external Stripe Connect Express account.
   *
   * Stub: Returns simulated success. Real implementation in Step 6.
   *
   * Expected payload:
   *   { userId, amount, currency, stripeConnectedAccountId }
   *
   * Real SDK call (Step 6):
   *   const payout = await stripe.payouts.create({
   *     amount: payload.amount * 100,
   *     currency: payload.currency,
   *     destination: payload.stripeConnectedAccountId,
   *     metadata: { userId: payload.userId }
   *   });
   *   return { success: true, providerRef: payout.id, rawResponse: payout };
   */
  async createPayout(payload: Record<string, unknown>): Promise<ProviderResult> {
    try {
      this.logger.log('Stripe stub — creating payout', {
        amount: payload['amount'],
        currency: payload['currency'],
      });

      const simulatedRef = `po_sim_${Date.now()}`;
      return {
        success: true,
        providerRef: simulatedRef,
        rawResponse: {
          id: simulatedRef,
          status: 'paid',
          amount: payload['amount'],
          currency: payload['currency'],
        },
      };
    } catch (error) {
      this.logger.error('Stripe createPayout threw', { error, payload });
      return {
        success: false,
        errorMessage:
          error instanceof Error ? error.message : 'Unexpected Stripe error',
        rawResponse: { error: String(error) },
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
