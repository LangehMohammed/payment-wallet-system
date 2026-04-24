export const AUTH_CONSTANTS = {
  /** Seconds within which a recently rotated token is still accepted */
  REFRESH_TOKEN_GRACE_PERIOD_SECONDS: 10,

  /** Bytes of entropy for refresh tokens — 40 bytes = 320 bits of entropy */
  REFRESH_TOKEN_BYTES: 40,

  /** Number of expired tokens to delete per batch during cleanup */
  CLEANUP_BATCH_SIZE: 1000,

  /** Milliseconds to wait between cleanup batches — prevents sustained DB pressure */
  CLEANUP_BATCH_DELAY_MS: 100,
} as const;
