import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { CurrentUser } from '@app/common/decorators/current-user.decorator';
import { Roles } from '@app/common/decorators/roles.decorator';
import { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { WalletService } from './wallet.service';
import { AdminWalletQueryDto, LedgerQueryDto } from './dto';

@ApiTags('Wallets')
@ApiBearerAuth()
@Controller('wallets')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  // ── User-facing ────────────────────────────────────────────────────────────

  @Get('me')
  @ApiOperation({ summary: 'Get own wallet — balances, currency, status' })
  @ApiResponse({
    status: 200,
    description: 'Returns the authenticated user wallet',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  getMyWallet(@CurrentUser() user: JwtPayload) {
    return this.walletService.getMyWallet(user.sub);
  }

  @Get('me/ledger')
  @ApiOperation({
    summary:
      'Get own ledger — cursor-paginated transaction history ordered by newest first',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Opaque cursor from the previous page response',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Entries per page (default 20, max 100)',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns a ledger page with entries and next cursor',
  })
  @ApiResponse({ status: 400, description: 'Invalid cursor' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  getMyLedger(@CurrentUser() user: JwtPayload, @Query() query: LedgerQueryDto) {
    return this.walletService.getMyLedger(user.sub, query);
  }

  // ── Admin-facing ───────────────────────────────────────────────────────────

  @Get()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      '[Admin] List all wallets — cursor-paginated, filterable by status and currency',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Opaque cursor from the previous page response',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Results per page (default 20, max 100)',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by wallet status',
  })
  @ApiQuery({
    name: 'currency',
    required: false,
    description: 'Filter by wallet currency',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns a paginated wallet list with next cursor',
  })
  @ApiResponse({ status: 400, description: 'Invalid cursor' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin only' })
  listWallets(@Query() query: AdminWalletQueryDto) {
    return this.walletService.listWallets(query);
  }

  @Get(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: '[Admin] Get any wallet by ID' })
  @ApiParam({ name: 'id', description: 'Wallet UUID' })
  @ApiResponse({
    status: 200,
    description: 'Returns the wallet with full balance detail',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin only' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  getWalletById(@Param('id', ParseUUIDPipe) id: string) {
    return this.walletService.getWalletById(id);
  }

  @Get(':id/ledger')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary:
      '[Admin] Get ledger for any wallet — cursor-paginated, ordered by newest first',
  })
  @ApiParam({ name: 'id', description: 'Wallet UUID' })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Opaque cursor from the previous page response',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Entries per page (default 20, max 100)',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns a ledger page with entries and next cursor',
  })
  @ApiResponse({ status: 400, description: 'Invalid cursor' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin only' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  getWalletLedger(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: LedgerQueryDto,
  ) {
    return this.walletService.getWalletLedger(id, query);
  }
}
