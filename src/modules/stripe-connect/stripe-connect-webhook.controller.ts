import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { Public } from '@app/common/decorators/public.decorator';
import { StripeConnectClient } from './stripe-connect.client';
import { StripeConnectWebhookService } from './stripe-connect-webhook.service';

type StripeEvent = ReturnType<StripeConnectClient['constructWebhookEvent']>;

/**
 * Receives and processes Stripe Connect webhook events.
 *
 * ## Raw body requirement
 * Stripe's `webhooks.constructEvent()` requires the raw unparsed request body
 * (a Buffer) to verify the HMAC-SHA256 signature. If the body has been parsed
 * by express.json() first, the byte-for-byte integrity is lost and verification
 * always fails. To provide the raw body, the app must be bootstrapped with
 * `rawBody: true` in `NestFactory.create()`.
 *
 * ## Stripe retry contract
 * Stripe retries events that receive a non-2xx response (with exponential
 * backoff for up to 3 days). This controller ALWAYS returns 200 after
 * signature verification passes — even if internal processing fails.
 * Business logic errors are logged; they must not propagate as HTTP errors.
 */
@ApiTags('Stripe Connect')
@Controller('stripe-connect/webhooks')
export class StripeConnectWebhookController {
  private readonly logger = new Logger(StripeConnectWebhookController.name);

  constructor(
    private readonly stripeConnectClient: StripeConnectClient,
    private readonly webhookService: StripeConnectWebhookService,
    private readonly configService: ConfigService,
  ) {}

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Public] Stripe Connect webhook receiver',
    description:
      'Receives signed Stripe Connect events. Requires raw body — see MAIN_TS_DIFF.md. ' +
      'Always returns 200 after signature verification; business logic errors are logged, ' +
      'not surfaced as HTTP errors (Stripe must not retry on our internal faults).',
  })
  @ApiResponse({ status: 200, description: 'Event acknowledged' })
  @ApiResponse({
    status: 401,
    description: 'Invalid or missing Stripe-Signature header',
  })
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: boolean }> {
    // ── Signature verification ───────────────────────────────────────────────

    const webhookSecret = this.configService.get<string>(
      'stripe.connectWebhookSecret',
    );

    if (!webhookSecret) {
      this.logger.error(
        'STRIPE_CONNECT_WEBHOOK_SECRET is not configured — rejecting all webhook requests',
      );
      throw new UnauthorizedException('Webhook endpoint not configured');
    }

    if (!signature) {
      this.logger.warn('Webhook received without Stripe-Signature header');
      throw new UnauthorizedException('Missing Stripe-Signature header');
    }

    const rawBody = req.rawBody;

    if (!rawBody) {
      // rawBody is only available when the app is bootstrapped with rawBody: true.
      // This is a misconfiguration error, not a client error.
      this.logger.error(
        'req.rawBody is undefined — ensure NestFactory.create() is called with { rawBody: true }',
      );
      throw new UnauthorizedException(
        'Webhook misconfigured — contact support',
      );
    }

    // constructWebhookEvent return type is inferred — stored as StripeEvent
    // (type alias above) so it can be passed to route() without Stripe.Event.
    let event: StripeEvent;
    try {
      event = this.stripeConnectClient.constructWebhookEvent(
        rawBody,
        signature,
        webhookSecret,
      );
    } catch (error) {
      this.logger.warn('Stripe webhook signature verification failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // ── Event routing ────────────────────────────────────────────────────────
    //
    // Routing is intentionally synchronous (await each handler) so that if
    // the handler throws unexpectedly we catch it here and still return 200.
    // Fire-and-forget (void) would silently swallow unhandled rejections.

    try {
      await this.route(event);
    } catch (error) {
      // Catch-all: business logic must never surface as a non-200 to Stripe.
      this.logger.error('Unhandled error in webhook event handler', {
        eventId: event.id,
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }

    return { received: true };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Routes a verified Stripe event to the correct handler method.
   *
   * Unrecognized event types are acknowledged with a debug log — Stripe sends
   * many event types we don't need. Silently ignoring them (rather than
   * logging a warning) avoids alert noise in production.
   *
   * To add a new handler:
   *   1. Add a case here
   *   2. Implement the method in StripeConnectWebhookService
   *   3. Add the event type to your Stripe webhook endpoint configuration
   */
  private async route(event: StripeEvent): Promise<void> {
    this.logger.log(`Routing Stripe Connect event: ${event.type}`, {
      eventId: event.id,
      account: event.account,
    });

    switch (event.type) {
      case 'account.updated':
        await this.webhookService.handleAccountUpdated(event);
        break;

      case 'account.application.deauthorized':
        await this.webhookService.handleAccountDeauthorized(event);
        break;

      case 'capability.updated':
        this.webhookService.handleCapabilityUpdated(event);
        break;

      default:
        this.logger.debug(
          `Unhandled Stripe Connect event type: ${event.type}`,
          { eventId: event.id },
        );
    }
  }
}
