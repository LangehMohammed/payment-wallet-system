import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionType } from '@prisma/client';
import * as braintree from 'braintree';
import {
  IPaymentProvider,
  DepositIntentResult,
} from './interface/payment-provider.interface';
import { ProviderResult } from '../dto/provider-result.dto';
import { ProviderConfigService } from './config/provider-config.service';

/**
 * PayPal payment provider adapter (Braintree for deposits, PayPal Payouts for withdrawals).
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
 *    NOTE: Currently stubbed — requires separate PayPal REST SDK (not Braintree)
 *
 * ## Error contract
 * All methods MUST NOT throw. Errors are caught and returned as
 * { success: false, errorMessage, rawResponse }.
 */
@Injectable()
export class PaypalProvider implements IPaymentProvider {
  private readonly logger = new Logger(PaypalProvider.name);
  private readonly gateway: braintree.BraintreeGateway;

  constructor(private readonly configService: ProviderConfigService) {
    const config = this.configService.BraintreeConfig;

    if (!config) {
      this.logger.warn(
        'Braintree credentials not configured — PayPal provider will fail on calls',
      );
    }

    // Initialize Braintree Gateway
    this.gateway = new braintree.BraintreeGateway({
      environment:
        config.environment === 'production'
          ? braintree.Environment.Production
          : braintree.Environment.Sandbox,
      merchantId: config.merchantId,
      publicKey: config.publicKey,
      privateKey: config.privateKey,
    });
  }

  // ── Deposit Intent ─────────────────────────────────────────────────────────

  /**
   * Generates a Braintree client token for Drop-in UI initialization.
   *
   * Expected payload:
   *   { userId, customerId? }
   *
   * SDK call:
   *   const response = await gateway.clientToken.generate({
   *     customerId: payload.customerId // loads vaulted payment methods if present
   *   });
   *   return { clientToken: response.clientToken };
   */
  async createDepositIntent(
    payload: Record<string, unknown>,
  ): Promise<DepositIntentResult> {
    try {
      const customerId = payload['customerId'] as string | undefined;
      const userId = String(payload['userId']);

      this.logger.log('Generating Braintree client token', {
        userId,
        customerId,
      });

      const options: braintree.ClientTokenRequest = {};
      if (customerId) {
        // If customerId exists, Braintree will load vaulted payment methods
        options.customerId = customerId;
      }

      const response = await this.gateway.clientToken.generate(options);

      this.logger.log('Braintree client token generated successfully', {
        userId,
      });

      return {
        success: true,
        clientToken: response.clientToken,
        rawResponse: {
          clientToken: response.clientToken,
          customerId: customerId || null,
        },
      };
    } catch (error) {
      this.logger.error('Braintree createDepositIntent failed', {
        error: error instanceof Error ? error.message : String(error),
        payload,
      });

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
   * Expected payload:
   *   { nonce, amount, currency, userId, customerId? }
   *
   * SDK call:
   *   const result = await gateway.transaction.sale({
   *     amount: payload.amount,
   *     paymentMethodNonce: payload.nonce,
   *     options: { storeInVaultOnSuccess: true, submitForSettlement: true },
   *     customerId: payload.customerId
   *   });
   */
  async confirmDeposit(
    payload: Record<string, unknown>,
  ): Promise<ProviderResult> {
    try {
      const nonce = String(payload['nonce']);
      const amount = String(payload['amount']);
      const currency = String(payload['currency']);
      const userId = String(payload['userId']);
      const customerId = payload['customerId'] as string | undefined;

      this.logger.log('Executing Braintree transaction.sale', {
        amount,
        currency,
        userId,
        hasCustomerId: !!customerId,
      });

      const saleRequest: braintree.TransactionRequest = {
        amount,
        paymentMethodNonce: nonce,
        options: {
          storeInVaultOnSuccess: true, // Vault PayPal account for future use
          submitForSettlement: true, // Auto-settle (no separate capture step)
        },
      };

      // If customerId exists, associate transaction with that customer
      if (customerId) {
        saleRequest.customerId = customerId;
      }

      const result = await this.gateway.transaction.sale(saleRequest);

      if (result.success && result.transaction) {
        this.logger.log('Braintree transaction succeeded', {
          transactionId: result.transaction.id,
          status: result.transaction.status,
        });

        return {
          success: true,
          providerRef: result.transaction.id,
          rawResponse: {
            id: result.transaction.id,
            status: result.transaction.status,
            amount: result.transaction.amount,
            currency: result.transaction.currencyIsoCode,
            payment_method: result.transaction.paymentInstrumentType,
          },
        };
      }

      // Transaction failed
      this.logger.warn('Braintree transaction failed', {
        message: result.message,
        errors: result.errors?.deepErrors(),
      });

      return {
        success: false,
        errorMessage: result.message || 'Braintree transaction failed',
        rawResponse: {
          id: result.transaction.id,
          status: result.transaction.status,
          amount: result.transaction.amount,
          currency: result.transaction.currencyIsoCode,
        },
      };
    } catch (error) {
      this.logger.error('Braintree confirmDeposit threw', {
        error: error instanceof Error ? error.message : String(error),
        payload,
      });

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
   * STUB: PayPal Payouts require a separate SDK (@paypal/payouts-sdk or REST API).
   * Braintree does NOT handle outbound payouts — only inbound payments (deposits).
   *
   * Expected payload:
   *   { userId, amount, currency, paypalEmail }
   *
   * Real implementation (Step 9):
   *   const paypal = require('@paypal/payouts-sdk');
   *   const request = new paypal.payouts.PayoutsPostRequest();
   *   request.requestBody({
   *     sender_batch_header: { ... },
   *     items: [{ recipient_type: 'EMAIL', receiver: paypalEmail, amount: { ... } }]
   *   });
   *   const response = await client.execute(request);
   */
  async createPayout(
    payload: Record<string, unknown>,
  ): Promise<ProviderResult> {
    try {
      const amount = payload['amount'];
      const currency = payload['currency'];
      const paypalEmail = payload['paypalEmail'];

      this.logger.log('PayPal payout stub — simulating success', {
        amount,
        currency,
        paypalEmail,
      });

      // TODO: Replace with real PayPal Payouts SDK integration (Step 9)
      const simulatedRef = `paypal_payout_${Date.now()}`;
      return {
        success: true,
        providerRef: simulatedRef,
        rawResponse: {
          batch_id: simulatedRef,
          status: 'SUCCESS',
          amount,
          currency,
          recipient_email: paypalEmail,
        },
      };
    } catch (error) {
      this.logger.error('PayPal createPayout threw', {
        error: error instanceof Error ? error.message : String(error),
        payload,
      });

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
