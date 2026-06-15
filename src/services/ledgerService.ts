import type { Prisma } from "@prisma/client";

export const LEDGER_TYPES = {
  DEPOSIT: "DEPOSIT",
  BET_DEBIT: "BET_DEBIT",
  BET_CREDIT: "BET_CREDIT",
  BET_REFUND: "BET_REFUND"
} as const;

export type LedgerType = (typeof LEDGER_TYPES)[keyof typeof LEDGER_TYPES];

export function ledgerDelta(entry: { type: string; amount: number }): number {
  if (entry.type === LEDGER_TYPES.BET_DEBIT) {
    return -entry.amount;
  }

  return entry.amount;
}

export async function appendLedger(
  tx: Prisma.TransactionClient,
  input: { userId: number; betId?: number; type: LedgerType; amount: number }
) {
  return tx.ledgerEntry.create({
    data: {
      userId: input.userId,
      betId: input.betId,
      type: input.type,
      amount: input.amount
    }
  });
}
