-- CreateTable
CREATE TABLE "ProcessedEvent" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "igUserId" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedEvent_eventKey_key" ON "ProcessedEvent"("eventKey");

-- CreateIndex
CREATE INDEX "ProcessedEvent_processedAt_idx" ON "ProcessedEvent"("processedAt");
