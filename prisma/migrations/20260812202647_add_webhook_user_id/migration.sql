-- AlterTable
ALTER TABLE "ConnectedAccount" ADD COLUMN     "webhookUserId" TEXT;

-- CreateIndex
CREATE INDEX "ConnectedAccount_webhookUserId_idx" ON "ConnectedAccount"("webhookUserId");
