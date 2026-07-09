import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { CurrentUser } from '@app/common/decorators/current-user.decorator';
import { Public } from '@app/common/decorators/public.decorator';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { StripeConnectService } from './stripe-connect.service';
import {
  ConnectAccountStatusDto,
  CreateConnectAccountResponseDto,
  RefreshOnboardingLinkResponseDto,
} from './dto/stripe-connect.dto';

@ApiTags('Stripe Connect')
@ApiBearerAuth()
@Controller('stripe-connect')
export class StripeConnectController {
  constructor(
    private readonly stripeConnectService: StripeConnectService,
    private readonly configService: ConfigService,
  ) {}

  // ── Account creation ───────────────────────────────────────────────────────

  @Post('accounts')
  @HttpCode(HttpStatus.OK)
  // 5 per hour — account creation is expensive; aggressive rate-limiting
  // prevents accidental or malicious Stripe account spam
  @Throttle({ global: { ttl: 60 * 60_000, limit: 5 } })
  @ApiOperation({
    summary:
      'Create or retrieve Stripe Connect Express account — returns onboarding URL',
    description:
      'If the user already has a linked Connect account, a fresh onboarding URL ' +
      'is returned for the existing account (idempotent). ' +
      'Redirect the user to `onboardingUrl` to complete identity verification. ' +
      'The link expires in 5 minutes.',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns accountId and Stripe-hosted onboarding URL',
    type: CreateConnectAccountResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 502,
    description: 'Stripe API unavailable — retry after a short delay',
  })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  createConnectAccount(@CurrentUser() user: JwtPayload) {
    return this.stripeConnectService.createConnectAccount(user.sub, user.email);
  }

  // ── Account status ─────────────────────────────────────────────────────────

  @Get('accounts/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Get own Stripe Connect account status — charges and payouts state",
    description:
      'Returns `onboardingState: "not_connected"` with zero capabilities if ' +
      'the user has not yet linked a Stripe account. No Stripe API call is made ' +
      'in that case. Payouts are only permitted when `payoutsEnabled` is true.',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns current Connect account state',
    type: ConnectAccountStatusDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 502,
    description: 'Stripe API unavailable — retry after a short delay',
  })
  getAccountStatus(@CurrentUser() user: JwtPayload) {
    return this.stripeConnectService.getAccountStatus(user.sub);
  }

  // ── Refresh link ───────────────────────────────────────────────────────────

  @Post('accounts/onboarding-link')
  @HttpCode(HttpStatus.OK)
  // 10 per hour — link refresh is cheap but shouldn't be abused
  @Throttle({ global: { ttl: 60 * 60_000, limit: 10 } })
  @ApiOperation({
    summary:
      'Generate a fresh onboarding link for an existing Connect account',
    description:
      'Use this when the original link has expired (after 5 minutes). ' +
      'Requires an existing linked Connect account — call `POST /stripe-connect/accounts` first.',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns a fresh Stripe-hosted onboarding URL',
    type: RefreshOnboardingLinkResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'No Connect account linked — call POST /stripe-connect/accounts first',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 502, description: 'Stripe API unavailable' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  refreshOnboardingLink(@CurrentUser() user: JwtPayload) {
    return this.stripeConnectService.refreshOnboardingLink(user.sub);
  }

  // ── Stripe redirect handlers ───────────────────────────────────────────────

  /**
   * Stripe redirects here after the user completes (or exits) the onboarding flow.
   *
   * This endpoint is PUBLIC — no JWT. Stripe hits it as a browser redirect;
   * there is no Authorization header. The redirect itself carries no meaningful
   * state — account enablement is confirmed via webhook, not this redirect.
   *
   * Implementation: redirect to the frontend, which polls
   * `GET /stripe-connect/accounts/status` to check the outcome.
   */
  @Get('onboarding/return')
  @Public()
  @HttpCode(HttpStatus.FOUND)
  @ApiOperation({
    summary:
      '[Public] Stripe redirect after onboarding — redirects to frontend',
    description:
      'Stripe redirects here after the user completes the onboarding flow. ' +
      'This does NOT confirm the account is fully verified — listen for ' +
      '`account.updated` webhooks for authoritative status. ' +
      'Redirects to STRIPE_CONNECT_FRONTEND_RETURN_URL.',
  })
  @ApiResponse({ status: 302, description: 'Redirects to frontend' })
  handleReturn(@Res() res: Response) {
    const frontendUrl = this.configService.get<string>(
      'stripe.connectFrontendReturnUrl',
    );
    return res.redirect(frontendUrl ?? '/');
  }

  /**
   * Stripe redirects here when the onboarding link has expired.
   *
   * Also PUBLIC. The user's session may still be valid in the frontend.
   * We redirect to the frontend with a query param so the frontend can
   * automatically call `POST /stripe-connect/accounts/onboarding-link`
   * to get a fresh link and re-redirect the user.
   */
  @Get('onboarding/refresh')
  @Public()
  @HttpCode(HttpStatus.FOUND)
  @ApiOperation({
    summary:
      '[Public] Stripe redirect when onboarding link expires — redirects to frontend',
    description:
      'Stripe redirects here when the account link has expired (5-minute TTL). ' +
      'Redirects to STRIPE_CONNECT_FRONTEND_RETURN_URL?refresh=true so the ' +
      'frontend knows to request a new onboarding link.',
  })
  @ApiResponse({ status: 302, description: 'Redirects to frontend with refresh=true' })
  handleRefresh(@Res() res: Response) {
    const frontendUrl = this.configService.get<string>(
      'stripe.connectFrontendReturnUrl',
    );
    const redirectUrl = frontendUrl
      ? `${frontendUrl}?refresh=true`
      : '/?refresh=true';
    return res.redirect(redirectUrl);
  }
}
