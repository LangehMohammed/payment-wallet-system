/**
 * Normalised result returned by every payment provider.
 *
 * Providers translate their own response shapes into this common type so the
 * processor never branches on provider-specific error codes or field names.
 */
export interface ProviderResult {
  success: boolean;

  /**
   * When true, the provider has accepted the request but settlement is async —
   * a webhook will carry the authoritative outcome. The processor marks the
   * outbox event delivered and exits; the webhook module drives settlement.
   *
   * When false (or absent), the provider result is synchronous and final.
   * The processor calls settlementService.settle() or .fail() immediately.
   *
   * Decision matrix:
   *   requiresWebhook: true  + success: true  → mark outbox delivered, await webhook
   *   requiresWebhook: true  + success: false → provider rejected before async
   *                                             processing began → call .fail()
   *   requiresWebhook: false + success: true  → call .settle() immediately (Braintree)
   *   requiresWebhook: false + success: false → call .fail() immediately
   */
  requiresWebhook?: boolean;

  /**
   * Provider's own reference ID for this transaction.
   * Stored in PaymentLog.providerRef and Transaction.providerRef on success.
   * May be present on failure if the provider assigned an ID before rejecting.
   */
  providerRef?: string;

  /**
   * Human-readable error description for failure cases.
   * Stored in PaymentLog for operational visibility.
   */
  errorMessage?: string;

  /**
   * Raw provider response payload — stored verbatim in PaymentLog.payload.
   * Must be JSON-serialisable.
   */
  rawResponse: Record<string, unknown>;
}
