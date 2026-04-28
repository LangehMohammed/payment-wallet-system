export const AuditEvent = {
  // Auth — identity and credential lifecycle
  USER_REGISTERED: 'USER_REGISTERED',
  USER_LOGIN: 'USER_LOGIN',
  LOGIN_BLOCKED_ACCOUNT: 'LOGIN_BLOCKED_ACCOUNT',
  TOKEN_REFRESHED: 'TOKEN_REFRESHED',

  // Session — token and session continuity
  SESSION_EVICTED: 'SESSION_EVICTED',
  GRACE_PERIOD_REPLAYED: 'GRACE_PERIOD_REPLAYED',
  GRACE_PERIOD_CACHE_MISS: 'GRACE_PERIOD_CACHE_MISS',

  // Logout — intentional session termination
  LOGOUT: 'LOGOUT',
  LOGOUT_ALL: 'LOGOUT_ALL',

  // Security — detected threats and policy violations
  TOKEN_REUSE_DETECTED: 'TOKEN_REUSE_DETECTED',
  LOGOUT_IDENTITY_MISMATCH: 'LOGOUT_IDENTITY_MISMATCH',
  SESSION_HIJACKING_ATTEMPT: 'SESSION_HIJACKING_ATTEMPT',

  // User - self-service profile and account lifecycle
  USER_PROFILE_UPDATED: 'USER_PROFILE_UPDATED',
  USER_PASSWORD_CHANGED: 'USER_PASSWORD_CHANGED',
  USER_ACCOUNT_CLOSED: 'USER_ACCOUNT_CLOSED',

  // Admin - privilaged mutations on user accounts
  ADMIN_USER_STATUS_UPDATED: 'ADMIN_USER_STATUS_UPDATED',

  // Infrastructure — internal system/control failures
  DENYLIST_FAILURE: 'DENYLIST_FAILURE',
} as const;

export type AuditEvent = (typeof AuditEvent)[keyof typeof AuditEvent];
