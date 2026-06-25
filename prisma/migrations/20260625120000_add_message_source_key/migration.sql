ALTER TABLE "Message" ADD COLUMN "sourceKey" TEXT;

CREATE UNIQUE INDEX "Message_sourceKey_key" ON "Message"("sourceKey");
