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
import { PaypalTokenClient } from './paypal-token.client';

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

  constructor(private readonly configService: ProviderConfigService, private readonly tokenClient: PaypalTokenClient) {
    const braintreeConfig = this.configService.BraintreeConfig;
    const paypalConfig = this.configService.PaypalConfig;


    if (!braintreeConfig) {
      this.logger.warn(
        'Braintree credentials not configured — PayPal provider will fail on calls',
      );
    }

    if (!paypalConfig) {
      this.logger.warn(
        'PayPal credentials not configured — PayPal payout functionality will fail',
      );
    }

    // Initialize Braintree Gateway
    this.gateway = new braintree.BraintreeGateway({
      environment:
        braintreeConfig.environment === 'production'
          ? braintree.Environment.Production
          : braintree.Environment.Sandbox,
      merchantId: braintreeConfig.merchantId,
      publicKey: braintreeConfig.publicKey,
      privateKey: braintreeConfig.privateKey,
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
   * Creates a payout via PayPal Payouts REST API (POST /v1/payments/payouts).
   *
   * Authentication: OAuth2 client credentials via PaypalTokenClient.
   * Token is cached in-process and refreshed automatically before expiry.
   *
   * Expected payload: { userId, walletId, amount, currency, paypalEmail }
   *
   * ## Payout batch vs. single item
   * The Payouts API creates a batch containing one item.
   * Single-item batches are standard practice for per-transaction payouts.
   * The batch_id is stored as providerRef for reconciliation.
   *
   * ## Async nature of PayPal payouts
   * Payouts are not synchronous — PayPal processes them asynchronously.
   * The API returns PENDING immediately and sends webhook notifications
   * (PAYMENT.PAYOUTSBATCH.PROCESSING, PAYMENT.PAYOUTSBATCH.SUCCESS, etc.)
   * when the batch completes. The webhook module (Step 12) will handle
   * final settlement confirmation.
   *
   * For now: success = batch accepted by PayPal (not yet delivered to recipient).
   */
  async createPayout(payload: Record<string, unknown>): Promise<ProviderResult> {
    try {
      const amount = String(payload['amount']);
      const currency = String(payload['currency']).toUpperCase();
      const paypalEmail = String(payload['paypalEmail']);
      const userId = String(payload['userId']);
      const walletId = String(payload['walletId']);
 
      this.logger.log('Creating PayPal payout via REST API', {
        amount,
        currency,
        userId,
        recipientEmail: paypalEmail,
      });
 
      const environment = this.configService.PaypalConfig.environment;
      const baseUrl =
        environment === 'production'
          ? 'https://api-m.paypal.com'
          : 'https://api-m.sandbox.paypal.com';
 
      // Fetch OAuth2 token (cached, refreshed automatically)
      const accessToken = await this.tokenClient.getAccessToken();
 
      // Unique sender_batch_id prevents duplicate payout submissions
      // on network retries — includes userId + timestamp for traceability
      const senderBatchId = `wallet_${walletId}_${Date.now()}`;
 
      const requestBody = {
        sender_batch_header: {
          sender_batch_id: senderBatchId,
          recipient_type: 'EMAIL',
          email_subject: 'You have received a payout',
          email_message: 'Your wallet withdrawal has been processed.',
        },
        items: [
          {
            amount: {
              value: amount,
              currency,
            },
            receiver: paypalEmail,
            note: 'Wallet withdrawal',
            sender_item_id: `${userId}_${Date.now()}`,
          },
        ],
      };
 
      const response = await fetch(`${baseUrl}/v1/payments/payouts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
 
      const responseBody = (await response.json()) as Record<string, unknown>;
 
      if (!response.ok) {
        this.logger.warn('PayPal Payouts API returned error', {
          status: response.status,
          body: responseBody,
        });
 
        return {
          success: false,
          errorMessage:
            (responseBody['message'] as string) ??
            `PayPal Payouts API error: ${response.status}`,
          rawResponse: responseBody,
        };
      }
 
      // Extract batch_header from response
      const batchHeader = responseBody['batch_header'] as Record<string, unknown>;
      const payoutBatchId = batchHeader?.['payout_batch_id'] as string;
      const batchStatus = batchHeader?.['batch_status'] as string;
 
      this.logger.log('PayPal payout batch created successfully', {
        payoutBatchId,
        batchStatus,
        senderBatchId,
      });
 
      return {
        success: true,
        providerRef: payoutBatchId,
        rawResponse: responseBody,
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
