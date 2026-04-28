import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuditLogger } from '@app/common/audit/audit-logger.service';
import { TokenDenylistService } from '../auth/token-denylist.service';
import { TokenService } from '../auth/token.service';
import {
  UsersRepository,
  UserProfile,
  UserWithWallet,
} from './users.repository';
import {
  AdminUpdateUserDto,
  ChangePasswordDto,
  UpdateProfileDto,
  UserQueryDto,
} from './dto';
import { AccountStatus } from '@prisma/client';

export interface PaginatedUsersResult {
  users: UserProfile[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly tokenDenylistService: TokenDenylistService,
    private readonly tokenService: TokenService,
    private readonly audit: AuditLogger,
  ) {}

  // ── User-facing ────────────────────────────────────────────────────────────

  async getMe(userId: string): Promise<UserWithWallet> {
    const user = await this.usersRepository.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<UserProfile> {
    if (!dto.name && !dto.phone) {
      throw new BadRequestException(
        'At least one field (name or phone) must be provided',
      );
    }

    if (dto.phone) {
      const existing = await this.usersRepository.checkPhoneTaken(dto.phone);
      if (existing) {
        throw new ConflictException('Phone number already in use');
      }
    }

    const updated = await this.usersRepository.updateProfile(userId, {
      ...(dto.name && { name: dto.name }),
      ...(dto.phone && { phone: dto.phone }),
    });

    this.audit.log('USER_PROFILE_UPDATED', { userId });
    return updated;
  }

  async changePassword(
    userId: string,
    jti: string,
    dto: ChangePasswordDto,
  ): Promise<void> {
    const user = await this.usersRepository.findByIdWithPassword(userId);
    if (!user) throw new NotFoundException('User not found');

    const currentPasswordValid = await argon2.verify(
      user.password,
      dto.currentPassword,
    );
    if (!currentPasswordValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const sameAsCurrentPassword = await argon2.verify(
      user.password,
      dto.newPassword,
    );
    if (sameAsCurrentPassword) {
      throw new BadRequestException(
        'New password must differ from current password',
      );
    }

    const hashed = await argon2.hash(dto.newPassword, {
      type: argon2.argon2id,
      memoryCost: 64 * 1024,
      timeCost: 3,
      parallelism: 4,
    });

    await this.usersRepository.updatePasswordAndRevokeSessions(userId, hashed);

    const ttl = this.tokenService.getAccessTokenTtlSeconds();
    await this.tokenDenylistService.revoke(jti, ttl);

    this.audit.log('USER_PASSWORD_CHANGED', { userId });
  }

  async closeAccount(userId: string, jti: string): Promise<void> {
    const user = await this.usersRepository.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    await this.usersRepository.closeAccount(userId);

    // Denylist the current access token — it is still valid until expiry
    // otherwise. Short-lived (5m default) but we close the window entirely.
    const ttl = this.tokenService.getAccessTokenTtlSeconds();
    await this.tokenDenylistService.revoke(jti, ttl);

    this.audit.log('USER_ACCOUNT_CLOSED', { userId });
  }

  // ── Admin-facing ───────────────────────────────────────────────────────────

  async listUsers(query: UserQueryDto): Promise<PaginatedUsersResult> {
    const { page, limit, status, role } = query;

    const { users, total } = await this.usersRepository.findAll(
      { status, role },
      { page, limit },
    );

    return {
      users,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getUserById(id: string): Promise<UserWithWallet> {
    const user = await this.usersRepository.findById(id);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateUserStatus(
    requesterId: string,
    targetId: string,
    dto: AdminUpdateUserDto,
  ): Promise<UserProfile> {
    if (!dto.status && !dto.role) {
      throw new BadRequestException(
        'At least one field (status or role) must be provided',
      );
    }

    // Prevent an admin from modifying their own status or role via the admin
    // endpoint — self-mutations must go through the user-facing endpoints.
    if (requesterId === targetId) {
      throw new ForbiddenException(
        'Administrators cannot modify their own account via this endpoint',
      );
    }

    const target = await this.usersRepository.findById(targetId);
    if (!target) throw new NotFoundException('User not found');

    if (dto.status === AccountStatus.CLOSED) {
      await this.usersRepository.closeAccount(targetId);

      this.audit.warn('ADMIN_USER_STATUS_UPDATED', {
        userId: requesterId,
        meta: { targetId, status: dto.status, role: dto.role },
      });

      // closeAccount already sets status to CLOSED — fetch and return the
      // updated profile rather than calling updateStatusOrRole redundantly.
      const updated = await this.usersRepository.findById(targetId);
      return updated as UserProfile;
    }

    await this.usersRepository.updateStatusOrRole(targetId, {
      status: dto.status,
      role: dto.role,
    });

    this.audit.warn('ADMIN_USER_STATUS_UPDATED', {
      userId: requesterId,
      meta: { targetId, status: dto.status, role: dto.role },
    });

    const updated = await this.usersRepository.findById(targetId);
    return updated;
  }
}
