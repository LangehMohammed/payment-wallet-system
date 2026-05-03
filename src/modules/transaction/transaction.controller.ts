import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { TransactionService } from './transaction.service';
import {
  DepositDto,
  TransactionQueryDto,
  TransferDto,
  WithdrawalDto,
} from './dto/transaction.dto';
import { CurrentUser } from '@app/common/decorators';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';

@ApiTags('Transactions')
@ApiBearerAuth()
@Controller('transactions')
export class TransactionController {
  constructor(private readonly transactionService: TransactionService) {}

  // ── Deposit ────────────────────────────────────────────────────────────────

  @Post('deposit')
  @HttpCode(HttpStatus.ACCEPTED) // 202 — initiated, not yet settled
  // 10 deposits per minute — prevents abuse while allowing legit burst
  @Throttle({ global: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary: 'Initiate a deposit — funds held as pending until settled',
  })
  @ApiResponse({ status: 202, description: 'Deposit initiated' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 403, description: 'Wallet is not active' })
  @ApiResponse({ status: 409, description: 'Idempotency key conflict' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  deposit(@Body() dto: DepositDto, @CurrentUser() user: JwtPayload) {
    return this.transactionService.deposit(user.sub, dto);
  }

  // ── Withdrawal ─────────────────────────────────────────────────────────────

  @Post('withdrawal')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ global: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary: 'Initiate a withdrawal — available balance locked until settled',
  })
  @ApiResponse({ status: 202, description: 'Withdrawal initiated' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 403, description: 'Wallet is not active' })
  @ApiResponse({ status: 422, description: 'Insufficient balance' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  withdraw(@Body() dto: WithdrawalDto, @CurrentUser() user: JwtPayload) {
    return this.transactionService.withdraw(user.sub, dto);
  }

  // ── Transfer ───────────────────────────────────────────────────────────────

  @Post('transfer')
  @HttpCode(HttpStatus.CREATED) // 201 — settles instantly
  @Throttle({ global: { ttl: 60_000, limit: 20 } })
  @ApiOperation({
    summary: 'P2P transfer — atomic, instant settlement between wallets',
  })
  @ApiResponse({ status: 201, description: 'Transfer settled' })
  @ApiResponse({
    status: 400,
    description: 'Validation error or self-transfer',
  })
  @ApiResponse({ status: 403, description: 'Wallet is not active' })
  @ApiResponse({ status: 422, description: 'Insufficient balance' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  transfer(@Body() dto: TransferDto, @CurrentUser() user: JwtPayload) {
    return this.transactionService.transfer(user.sub, dto);
  }

  // ── History ────────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'Paginated transaction history for the authenticated user',
  })
  @ApiResponse({ status: 200, description: 'Paginated transaction list' })
  getHistory(
    @Query() query: TransactionQueryDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.transactionService.getTransactionHistory(user.sub, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single transaction by ID' })
  @ApiResponse({ status: 200, description: 'Transaction detail' })
  @ApiResponse({ status: 403, description: 'Not your transaction' })
  getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.transactionService.getTransaction(user.sub, id);
  }
}
