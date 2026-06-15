import type { PrismaClient } from "@prisma/client";

export async function ensureDatabaseSchema(prisma: PrismaClient) {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "User" (
      "id" INTEGER NOT NULL PRIMARY KEY,
      "username" TEXT NOT NULL,
      "balance" INTEGER NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Bet" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "userId" INTEGER NOT NULL,
      "gameId" TEXT NOT NULL,
      "amount" INTEGER NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'PLACED',
      "result" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "settledAt" DATETIME,
      CONSTRAINT "Bet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id")
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "LedgerEntry" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "userId" INTEGER NOT NULL,
      "betId" INTEGER,
      "type" TEXT NOT NULL,
      "amount" INTEGER NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "LedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id"),
      CONSTRAINT "LedgerEntry_betId_fkey" FOREIGN KEY ("betId") REFERENCES "Bet" ("id")
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "LedgerEntry_userId_idx" ON "LedgerEntry"("userId")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "LedgerEntry_betId_idx" ON "LedgerEntry"("betId")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "LedgerEntry_betId_type_key"
    ON "LedgerEntry"("betId", "type")
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "IdempotencyRecord" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "key" TEXT NOT NULL,
      "scope" TEXT NOT NULL,
      "requestHash" TEXT NOT NULL,
      "statusCode" INTEGER NOT NULL,
      "responseBody" TEXT NOT NULL,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "IdempotencyRecord_key_scope_key"
    ON "IdempotencyRecord"("key", "scope")
  `);
}
