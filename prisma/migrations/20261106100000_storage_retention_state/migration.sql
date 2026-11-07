-- Storage retention: when its sweep last ran with storageRetention on, and
-- when it last resumed (src/modules/storage-retention/). Additive only. No
-- row is written here: the first sweep after deploy records a resume, so
-- nothing is deleted by a retention rule for 7 days after it.

-- CreateTable
CREATE TABLE "StorageRetentionState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "lastSweptAt" TIMESTAMP(3),
    "resumedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageRetentionState_pkey" PRIMARY KEY ("id")
);
