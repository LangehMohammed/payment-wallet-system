import { ApiProperty } from '@nestjs/swagger';

// ── Onboarding ─────────────────────────────────────────────────────────────────

export class CreateConnectAccountResponseDto {
  @ApiProperty({
    description: 'Stripe Connect Express account ID',
    example: 'acct_1234567890abcdef',
  })
  accountId: string;

  @ApiProperty({
    description:
      'Stripe-hosted onboarding URL. Redirect the user here to complete ' +
      'identity verification and bank account setup. Valid for 5 minutes.',
    example: 'https://connect.stripe.com/setup/e/acct_xxx/yyy',
  })
  onboardingUrl: string;
}

// ── Account Status ─────────────────────────────────────────────────────────────

export class ConnectAccountStatusDto {
  @ApiProperty({
    description: 'Stripe Connect Express account ID',
    example: 'acct_1234567890abcdef',
    nullable: true,
  })
  accountId: string | null;

  @ApiProperty({
    description:
      'Whether Stripe has verified the account and enabled charges. ' +
      'Payouts are only permitted when this is true.',
    example: false,
  })
  chargesEnabled: boolean;

  @ApiProperty({
    description:
      'Whether Stripe has enabled payouts to the connected bank account.',
    example: false,
  })
  payoutsEnabled: boolean;

  @ApiProperty({
    description: 'Current onboarding state derived from Stripe account data.',
    enum: ['not_connected', 'pending', 'complete', 'restricted'],
    example: 'pending',
  })
  onboardingState: 'not_connected' | 'pending' | 'complete' | 'restricted';
}

// ── Refresh Link ───────────────────────────────────────────────────────────────

export class RefreshOnboardingLinkResponseDto {
  @ApiProperty({
    description: 'Fresh Stripe-hosted onboarding URL. Valid for 5 minutes.',
    example: 'https://connect.stripe.com/setup/e/acct_xxx/yyy',
  })
  onboardingUrl: string;
}