import { ProviderResult } from '../../dto/provider-result.dto';
import { TransactionType } from '@prisma/client';

/**
 * Contract every payment provider adapter must implement.
 *
 * Each adapter is responsible for:
 *   1. Creating deposit intents (client_secret / client_token for frontend).
 *   2. Confirming deposits after frontend payment method collection.
 *   3. Creating payouts (withdrawals to external accounts).
 *   4. Normalising all responses into ProviderResult or DepositIntentResult.
 *   5. Never throwing — all errors must be caught and returned as failures.
 *
 * The processor calls the appropriate method based on transaction type and state.
 */
export interface IPaymentProvider {
  /**
   * Creates a deposit intent for frontend payment collection.
   *
   * Stripe: Returns PaymentIntent client_secret for stripe.confirmUsBankAccountPayment()
   * PayPal/Braintree: Returns client_token for Drop-in UI initialization
   *
   * @param payload - { userId, amount, currency, ...provider-specific fields }
   * @returns { clientSecret } or { clientToken } — never throws.
   */
  createDepositIntent(
    payload: Record<string, unknown>,
  ): Promise<DepositIntentResult>;

  /**
   * Confirms a deposit after the frontend has collected payment details.
   *
   * Stripe: Verifies PaymentIntent status after frontend confirmation
   * PayPal/Braintree: Executes transaction.sale with payment nonce + vaulting
   *
   * Called either:
   *   a) Synchronously in POST /payments/deposits/confirm (immediate settlement)
   *   b) Asynchronously by the outbox processor (deferred settlement)
   *
   * @param payload - { paymentIntentId, paymentMethodId } (Stripe) or { nonce } (Braintree)
   * @returns ProviderResult — never throws.
   */
  confirmDeposit(payload: Record<string, unknown>): Promise<ProviderResult>;

  /**
   * Creates a payout (withdrawal) to an external account.
   *
   * Stripe: stripe.payouts.create() (requires Connect Express account)
   * PayPal: PayPal Payouts API call
   *
   * @param payload - { userId, amount, currency, externalAccountId }
   * @returns ProviderResult — never throws.
   */
  createPayout(payload: Record<string, unknown>): Promise<ProviderResult>;

  /**
   * Unified entry point for the outbox processor.
   *
   * Routes to confirmDeposit() or createPayout() based on transaction type.
   * This method exists to maintain backwards compatibility with the processor's
   * current `provider.process()` call pattern.
   *
   * @deprecated Use confirmDeposit() or createPayout() directly when possible.
   */
  process(
    payload: Record<string, unknown>,
    transactionType: TransactionType,
  ): Promise<ProviderResult>;
}

/**
 * Result returned by createDepositIntent().
 *
 * Contains the frontend-facing credential (client_secret or client_token)
 * needed to initialize the payment collection UI.
 */
export interface DepositIntentResult {
  success: boolean;

  /**
   * Stripe: PaymentIntent client_secret
   * Braintree: Generated client_token
   */
  clientSecret?: string;
  clientToken?: string;

  /**
   * Provider's internal ID for this intent (e.g., PaymentIntent ID).
   * Stored in the backend and passed to confirmDeposit().
   */
  intentId?: string;

  /**
   * Error message if intent creation failed.
   */
  errorMessage?: string;

  /**
   * Raw provider response for logging.
   */
  rawResponse: Record<string, unknown>;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
