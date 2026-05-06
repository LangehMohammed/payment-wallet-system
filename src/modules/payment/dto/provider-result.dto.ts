/**
 * Normalised result returned by every payment provider.
 *
 * Providers translate their own response shapes into this common type so the
 * processor never branches on provider-specific error codes or field names.
 */
export interface ProviderResult {
  success: boolean;

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
