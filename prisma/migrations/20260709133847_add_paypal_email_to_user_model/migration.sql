/*
  Warnings:

  - A unique constraint covering the columns `[paypalEmail]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "paypalEmail" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_paypalEmail_key" ON "User"("paypalEmail");
