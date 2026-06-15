import { prisma } from "../db.js";
import { LEDGER_TYPES, ledgerDelta } from "./ledgerService.js";

export async function reconcileUser(userId: number) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return null;
  }

  const [ledgerEntries, bets, groupedBets] = await Promise.all([
    prisma.ledgerEntry.findMany({ where: { userId } }),
    prisma.bet.findMany({ where: { userId }, include: { ledger: true } }),
    prisma.bet.groupBy({
      by: ["status"],
      where: { userId },
      _count: { status: true }
    })
  ]);

  const calculatedBalance = ledgerEntries.reduce(
    (sum, entry) => sum + ledgerDelta(entry),
    0
  );

  const betStatusCounts = groupedBets.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = item._count.status;
    return acc;
  }, {});

  // Reconciliation checks invariants that normal service paths are expected to maintain.
  const anomalies = bets.flatMap((bet) => {
    const issues: Array<{ betId: number; type: string; message: string }> = [];
    const debitCount = bet.ledger.filter((entry) => entry.type === LEDGER_TYPES.BET_DEBIT).length;
    const creditCount = bet.ledger.filter((entry) => entry.type === LEDGER_TYPES.BET_CREDIT).length;
    const refundCount = bet.ledger.filter((entry) => entry.type === LEDGER_TYPES.BET_REFUND).length;

    if (debitCount === 0) {
      issues.push({
        betId: bet.id,
        type: "MISSING_BET_DEBIT",
        message: "bet has no debit ledger entry"
      });
    }

    if (creditCount > 1) {
      issues.push({
        betId: bet.id,
        type: "DUPLICATE_SETTLEMENT_CREDIT",
        message: "bet has multiple credit ledger entries"
      });
    }

    if (refundCount > 1) {
      issues.push({
        betId: bet.id,
        type: "DUPLICATE_REFUND",
        message: "bet has multiple refund ledger entries"
      });
    }

    if (bet.status === "CANCELLED" && refundCount === 0) {
      issues.push({
        betId: bet.id,
        type: "MISSING_REFUND",
        message: "cancelled bet has no refund ledger entry"
      });
    }

    if (bet.status !== "CANCELLED" && refundCount > 0) {
      issues.push({
        betId: bet.id,
        type: "UNEXPECTED_REFUND",
        message: "non-cancelled bet has a refund ledger entry"
      });
    }

    if (bet.status !== "SETTLED" && creditCount > 0) {
      issues.push({
        betId: bet.id,
        type: "UNEXPECTED_CREDIT",
        message: "unsettled bet has a credit ledger entry"
      });
    }

    return issues;
  });

  if (user.balance !== calculatedBalance) {
    anomalies.push({
      betId: 0,
      type: "BALANCE_MISMATCH",
      message: "stored user balance does not match ledger-derived balance"
    });
  }

  return {
    userId,
    storedBalance: user.balance,
    calculatedBalance,
    betStatusCounts,
    anomalies
  };
}
