-- DropIndex
DROP INDEX "RefreshToken_userId_idx";

-- DropIndex
DROP INDEX "RefreshToken_userId_revokedAt_idx";

-- CreateIndex
CREATE INDEX "RefreshToken_userId_revokedAt_expiresAt_idx" ON "RefreshToken"("userId", "revokedAt", "expiresAt");
