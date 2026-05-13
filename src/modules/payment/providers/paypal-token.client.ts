import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface CachedToken {
  accessToken: string;
  expiresAt: number; // Unix timestamp ms
}

/**
 * PayPal OAuth2 token client.
 *
 * Fetches and caches access tokens for the PayPal REST API.
 * Tokens are valid for 32400 seconds (9 hours) — we refresh 60 seconds
 * early to avoid edge-case expiry on in-flight requests.
 *
 * ## Token caching
 * In-process cache — one token per process instance. This is intentional:
 * - Tokens are long-lived (9h), so cache thrashing is not a concern.
 * - In-memory is simpler than Redis for a single credential set.
 * - If the process restarts, a fresh token is fetched on the first call.
 */
@Injectable()
export class PaypalTokenClient {
  private readonly logger = new Logger(PaypalTokenClient.name);
  private cachedToken: CachedToken | null = null;

  // Refresh 60s before actual expiry to avoid edge-case failures
  private static readonly EXPIRY_BUFFER_MS = 60 * 1000;

  constructor(private readonly configService: ConfigService) {}

  /**
   * Returns a valid access token, fetching a new one if the cached token
   * is missing or within the expiry buffer window.
   */
  async getAccessToken(): Promise<string> {
    if (this.isTokenValid()) {
      return this.cachedToken!.accessToken;
    }

    return this.fetchAndCacheToken();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private isTokenValid(): boolean {
    if (!this.cachedToken) return false;
    return (
      Date.now() < this.cachedToken.expiresAt - PaypalTokenClient.EXPIRY_BUFFER_MS
    );
  }

  /**
   * Calls POST /v1/oauth2/token with client_credentials grant.
   * Caches the resulting token with its expiry window.
   */
  private async fetchAndCacheToken(): Promise<string> {
    const clientId = this.configService.get<string>('paypal.clientId');
    const clientSecret = this.configService.get<string>('paypal.clientSecret');
    const environment = this.configService.get<string>('paypal.environment');

    if (!clientId || !clientSecret) {
      throw new Error(
        'PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be configured for PayPal payouts.',
      );
    }

    const baseUrl =
      environment === 'production'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';

    this.logger.log('Fetching new PayPal access token', { environment });

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
      'base64',
    );

    const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `PayPal OAuth2 token fetch failed: ${response.status} ${response.statusText} — ${errorBody}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number; // seconds
    };

    this.cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    this.logger.log('PayPal access token fetched successfully', {
      expiresInSeconds: data.expires_in,
    });

    return this.cachedToken.accessToken;
  }
}