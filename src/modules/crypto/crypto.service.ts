import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * AES-256-GCM authenticated encryption for sensitive cache values.
 *
 * ## Algorithm choice: AES-256-GCM
 * - Authenticated encryption: encrypts AND integrity-checks in one pass.
 *   A tampered or forged ciphertext throws on decrypt — no silent corruption.
 * - 256-bit key: exceeds NIST minimum for long-term security.
 * - GCM is FIPS-approved and hardware-accelerated on modern CPUs (AES-NI).
 *
 * ## IV strategy
 * A fresh cryptographically random 12-byte IV is generated per encryption.
 * IVs are never reused. The IV is prepended to the ciphertext and the auth
 * tag is appended — the stored format is:
 *
 *   [12 bytes IV][N bytes ciphertext][16 bytes auth tag]
 *
 * All stored as a single hex string.
 *
 * ## Key derivation
 * CACHE_ENCRYPTION_KEY is a 64-char hex string (32 bytes / 256 bits).
 * It is validated eagerly in the constructor — misconfiguration surfaces
 * at module load time, not on the first cache write.
 *
 * ## Constructor vs onModuleInit resolution
 * The key is resolved in the constructor rather than onModuleInit so that
 * unit tests using `new CryptoService(configService)` (without triggering
 * the NestJS lifecycle) can call encrypt/decrypt immediately. onModuleInit
 * is retained as a no-op hook for interface compliance; the constructor
 * resolution is idempotent and safe to call multiple times.
 *
 * ## Key separation
 * TOKEN_HASH_SECRET and CACHE_ENCRYPTION_KEY are intentionally separate env
 * vars. One secret, one purpose — reusing TOKEN_HASH_SECRET here would couple
 * two unrelated cryptographic operations to the same key material.
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private static readonly ALGORITHM = 'aes-256-gcm' as const;
  private static readonly IV_BYTES = 12; // 96-bit IV  — GCM standard
  private static readonly TAG_BYTES = 16; // 128-bit auth tag — GCM maximum
  private static readonly KEY_HEX_LENGTH = 64; // 32 bytes = 256 bits as hex

  private readonly encryptionKey: Buffer;

  constructor(private readonly configService: ConfigService) {
    // Resolve and validate immediately so any misconfiguration is caught at
    // startup (or test instantiation) rather than silently at first use.
    this.encryptionKey = this.resolveKey();
  }

  /**
   * Retained for NestJS lifecycle interface compliance.
   * Key resolution has already happened in the constructor — this is a no-op.
   */
  onModuleInit(): void {
    // Intentional no-op: key resolved in constructor.
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Encrypts `plaintext` and returns a hex string:
   *   [12-byte IV][ciphertext][16-byte GCM auth tag]
   */
  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(CryptoService.IV_BYTES);
    const cipher = crypto.createCipheriv(
      CryptoService.ALGORITHM,
      this.encryptionKey,
      iv,
    );

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const tag = cipher.getAuthTag();

    return Buffer.concat([iv, encrypted, tag]).toString('hex');
  }

  /**
   * Decrypts a hex string produced by `encrypt`.
   * Throws if the ciphertext has been tampered with (GCM auth tag mismatch).
   */
  decrypt(hex: string): string {
    const buf = Buffer.from(hex, 'hex');

    const iv = buf.subarray(0, CryptoService.IV_BYTES);
    const tag = buf.subarray(buf.length - CryptoService.TAG_BYTES);
    const ciphertext = buf.subarray(
      CryptoService.IV_BYTES,
      buf.length - CryptoService.TAG_BYTES,
    );

    const decipher = crypto.createDecipheriv(
      CryptoService.ALGORITHM,
      this.encryptionKey,
      iv,
    );
    decipher.setAuthTag(tag);

    return (
      decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8')
    );
  }

  // ── Key resolution ───────────────────────────────────────────────────────────

  private resolveKey(): Buffer {
    const hex = this.configService.get<string>('cache.encryptionKey');

    if (!hex || hex.length !== CryptoService.KEY_HEX_LENGTH) {
      throw new Error(
        `CACHE_ENCRYPTION_KEY must be a ${CryptoService.KEY_HEX_LENGTH}-character ` +
          'hex string (32 bytes / 256 bits). ' +
          "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }

    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error(
        'CACHE_ENCRYPTION_KEY must contain only hexadecimal characters (0-9, a-f).',
      );
    }

    return Buffer.from(hex, 'hex');
  }
}
