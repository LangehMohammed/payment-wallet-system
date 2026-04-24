-- DropIndex
DROP INDEX "RefreshToken_userId_revokedAt_expiresAt_idx";

-- CreateIndex
CREATE INDEX "RefreshToken_userId_revokedAt_expiresAt_createdAt_idx" ON "RefreshToken"("userId", "revokedAt", "expiresAt", "createdAt");
