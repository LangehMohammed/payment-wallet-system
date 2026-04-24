/*
  Warnings:

  - The `currency` column on the `LedgerEntry` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `deviceInfo` on the `RefreshToken` table. All the data in the column will be lost.
  - The `currency` column on the `Transaction` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `currency` column on the `Wallet` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "LedgerEntry" DROP COLUMN "currency",
ADD COLUMN     "currency" "Currency" NOT NULL DEFAULT 'USD';

-- AlterTable
ALTER TABLE "RefreshToken" DROP COLUMN "deviceInfo";

-- AlterTable
ALTER TABLE "Transaction" DROP COLUMN "currency",
ADD COLUMN     "currency" "Currency" NOT NULL DEFAULT 'USD';

-- AlterTable
ALTER TABLE "Wallet" DROP COLUMN "currency",
ADD COLUMN     "currency" "Currency" NOT NULL DEFAULT 'USD';
