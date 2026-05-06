import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionType } from '@prisma/client';
import {
  IPaymentProvider,
  DepositIntentResult,
} from './interface/payment-provider.interface';
import { ProviderResult } from '../dto/provider-result.dto';

/**
 * PayPal payment provider adapter (Braintree for deposits, PayPal Payouts for withdrawals).
 *
 * ## Current state (Step 1)
 * Method signatures implemented with stubs. Real Braintree + PayPal SDK
 * integration happens in Steps 7-9.
 *
 * ## Deposit Flow (Braintree + Vault)
 * 1. createDepositIntent() → braintree.clientToken.generate({ customerId })
 *    Returns client_token for Braintree Drop-in UI initialization
 * 2. Frontend: User authenticates PayPal via Drop-in, returns payment nonce
 * 3. confirmDeposit() → braintree.transaction.sale({ paymentMethodNonce, options: { storeInVaultOnSuccess: true } })
 *    Vaults the PayPal account for future use, returns transaction ID
 *
 * ## Payout Flow (PayPal Payouts API)
 * 1. createPayout() → PayPal Payouts API call
 *    Requires merchant to have PayPal business account with Payouts enabled
 *
 * ## Error contract
 * All methods MUST NOT throw. Errors are caught and returned as
 * { success: false, errorMessage, rawResponse }.
 */
@Injectable()
export class PaypalProvider implements IPaymentProvider {
  private readonly logger = new Logger(PaypalProvider.name);

  constructor(private readonly configService: ConfigService) {}

  // ── Deposit Intent ─────────────────────────────────────────────────────────

  /**
   * Generates a Braintree client token for Drop-in UI initialization.
   *
   * Stub: Returns simulated client_token. Real implementation in Step 8.
   *
   * Expected payload:
   *   { userId, customerId? } (customerId is Braintree's internal user ID if user has vaulted payments)
   *
   * Real SDK call (Step 8):
   *   const gateway = new braintree.BraintreeGateway({ ... });
   *   const response = await gateway.clientToken.generate({
   *     customerId: payload.customerId // loads vaulted payment methods if present
   *   });
   *   return { success: true, clientToken: response.clientToken };
   */
  async createDepositIntent(
    payload: Record<string, unknown>,
  ): Promise<DepositIntentResult> {
    try {
      this.logger.log('Braintree stub — generating client token', {
        userId: payload['userId'],
        customerId: payload['customerId'],
      });

      const simulatedToken = `bt_token_sim_${Date.now()}`;

      return {
        success: true,
        clientToken: simulatedToken,
        rawResponse: {
          clientToken: simulatedToken,
          customerId: payload['customerId'],
        },
      };
    } catch (error) {
      this.logger.error('Braintree createDepositIntent threw', { error, payload });
      return {
        success: false,
        errorMessage:
          error instanceof Error ? error.message : 'Unexpected Braintree error',
        rawResponse: { error: String(error) },
      };
    }
  }

  // ── Deposit Confirmation ───────────────────────────────────────────────────

  /**
   * Executes a Braintree sale with payment nonce and vaults the payment method.
   *
   * Stub: Returns simulated success. Real implementation in Step 8.
   *
   * Expected payload:
   *   { nonce, amount, currency, userId, customerId? }
   *
   * Real SDK call (Step 8):
   *   const result = await gateway.transaction.sale({
   *     amount: payload.amount,
   *     paymentMethodNonce: payload.nonce,
   *     options: {
   *       storeInVaultOnSuccess: true,
   *       submitForSettlement: true
   *     },
   *     customerId: payload.customerId // or create new customer if absent
   *   });
   *   if (result.success) {
   *     return { success: true, providerRef: result.transaction.id, rawResponse: result.transaction };
   *   }
   *   return { success: false, errorMessage: result.message, rawResponse: result };
   */
  async confirmDeposit(
    payload: Record<string, unknown>,
  ): Promise<ProviderResult> {
    try {
      this.logger.log('Braintree stub — confirming deposit', {
        nonce: payload['nonce'],
        amount: payload['amount'],
      });

      const simulatedRef = `bt_txn_${Date.now()}`;
      return {
        success: true,
        providerRef: simulatedRef,
        rawResponse: {
          id: simulatedRef,
          status: 'settled',
          amount: payload['amount'],
          currency: payload['currency'],
        },
      };
    } catch (error) {
      this.logger.error('Braintree confirmDeposit threw', { error, payload });
      return {
        success: false,
        errorMessage:
          error instanceof Error ? error.message : 'Unexpected Braintree error',
        rawResponse: { error: String(error) },
      };
    }
  }

  // ── Payout ─────────────────────────────────────────────────────────────────

  /**
   * Creates a payout via PayPal Payouts API.
   *
   * Stub: Returns simulated success. Real implementation in Step 9.
   *
   * Expected payload:
   *   { userId, amount, currency, paypalEmail }
   *
   * Real SDK call (Step 9):
   *   const payoutBatch = await paypal.payouts.create({
   *     sender_batch_header: { ... },
   *     items: [{
   *       recipient_type: 'EMAIL',
   *       amount: { value: payload.amount, currency: payload.currency },
   *       receiver: payload.paypalEmail
   *     }]
   *   });
   *   return { success: true, providerRef: payoutBatch.batch_header.payout_batch_id, rawResponse: payoutBatch };
   */
  async createPayout(payload: Record<string, unknown>): Promise<ProviderResult> {
    try {
      this.logger.log('PayPal stub — creating payout', {
        amount: payload['amount'],
        currency: payload['currency'],
        paypalEmail: payload['paypalEmail'],
      });

      const simulatedRef = `paypal_payout_${Date.now()}`;
      return {
        success: true,
        providerRef: simulatedRef,
        rawResponse: {
          batch_id: simulatedRef,
          status: 'SUCCESS',
          amount: payload['amount'],
          currency: payload['currency'],
        },
      };
    } catch (error) {
      this.logger.error('PayPal createPayout threw', { error, payload });
      return {
        success: false,
        errorMessage:
          error instanceof Error ? error.message : 'Unexpected PayPal error',
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
