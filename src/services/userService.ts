import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import { withIdempotency } from "./idempotencyService.js";
import { appendLedger, LEDGER_TYPES } from "./ledgerService.js";

function assertPositiveAmount(amount: unknown): asserts amount is number {
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    throw badRequest("amount must be a positive integer");
  }
}

export async function depositUser(input: {
  userId: number;
  amount: number;
  idempotencyKey: string;
}) {
  assertPositiveAmount(input.amount);

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Idempotency record, balance increment, and ledger append commit atomically.
    return withIdempotency(tx, "user.deposit", input.idempotencyKey, {
      userId: input.userId,
      amount: input.amount
    }, async () => {
      const user = await tx.user.findUnique({ where: { id: input.userId } });
      if (!user) {
        throw notFound("user not found");
      }

      const updatedUser = await tx.user.update({
        where: { id: input.userId },
        data: { balance: { increment: input.amount } }
      });

      // Ledger is append-only; historical financial records are never edited.
      const ledger = await appendLedger(tx, {
        userId: input.userId,
        type: LEDGER_TYPES.DEPOSIT,
        amount: input.amount
      });

      return {
        statusCode: 200,
        body: {
          userId: updatedUser.id,
          balance: updatedUser.balance,
          ledgerEntryId: ledger.id
        }
      };
    });
  });
}
