import * as argon2 from 'argon2';

export const AUTH_CONSTANTS = {
  /** Seconds within which a recently rotated refresh token is still accepted */
  REFRESH_TOKEN_GRACE_PERIOD_SECONDS: 10,

  /** Bytes of entropy for refresh tokens — 40 bytes = 320 bits of entropy */
  REFRESH_TOKEN_BYTES: 40,

  /** Number of expired tokens to delete per batch during cleanup */
  CLEANUP_BATCH_SIZE: 1000,

  /** Milliseconds to wait between cleanup batches — prevents sustained DB pressure */
  CLEANUP_BATCH_DELAY_MS: 100,

  /**
   * Argon2id hashing parameters — single source of truth for ALL call sites.
   *
   * Consumed by:
   *   - AuthService.register()
   *   - UsersService.changePassword()
   *   - AuthService.DUMMY_HASH (pre-computed — must be regenerated if these change)
   *
   * ⚠️  If any value changes here, DUMMY_HASH must be regenerated:
   *   node -e "
   *     const a = require('argon2');
   *     a.hash('dummy_password', {
   *       type: a.argon2id,
   *       memoryCost: 65536,
   *       timeCost: 3,
   *       parallelism: 4,
   *     }).then(console.log)
   *   "
   */
  ARGON2_OPTIONS: {
    type: argon2.argon2id,
    memoryCost: 64 * 1024, // 64 MiB
    timeCost: 3,
    parallelism: 4,
  } as const satisfies argon2.Options,
} as const;
