import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { withIdempotency } from "./idempotencyService.js";
import { appendLedger, LEDGER_TYPES } from "./ledgerService.js";

const BET_STATUS = {
  PLACED: "PLACED",
  SETTLED: "SETTLED",
  CANCELLED: "CANCELLED"
} as const;

function assertPositiveAmount(amount: unknown): asserts amount is number {
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    throw badRequest("amount must be a positive integer");
  }
}

export async function placeBet(input: {
  userId: number;
  gameId: string;
  amount: number;
  idempotencyKey: string;
}) {
  assertPositiveAmount(input.amount);
  if (!input.gameId) {
    throw badRequest("gameId is required");
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // The idempotency record is written in the same transaction as the debit and ledger.
    return withIdempotency(tx, "bet.place", input.idempotencyKey, {
      userId: input.userId,
      gameId: input.gameId,
      amount: input.amount
    }, async () => {
      // Conditional update prevents concurrent requests from overdrawing the account.
      const debit = await tx.user.updateMany({
        where: {
          id: input.userId,
          balance: { gte: input.amount }
        },
        data: { balance: { decrement: input.amount } }
      });

      if (debit.count === 0) {
        const user = await tx.user.findUnique({ where: { id: input.userId } });
        if (!user) {
          throw notFound("user not found");
        }
        throw conflict("insufficient balance");
      }

      const updatedUser = await tx.user.findUniqueOrThrow({
        where: { id: input.userId }
      });

      const bet = await tx.bet.create({
        data: {
          userId: input.userId,
          gameId: input.gameId,
          amount: input.amount,
          status: BET_STATUS.PLACED
        }
      });

      const ledger = await appendLedger(tx, {
        userId: input.userId,
        betId: bet.id,
        type: LEDGER_TYPES.BET_DEBIT,
        amount: input.amount
      });

      return {
        statusCode: 201,
        body: {
          bet,
          balance: updatedUser.balance,
          ledgerEntryId: ledger.id
        }
      };
    });
  });
}

export async function settleBet(input: { betId: number; result: "WIN" | "LOSE" }) {
  if (input.result !== "WIN" && input.result !== "LOSE") {
    throw badRequest("result must be WIN or LOSE");
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const bet = await tx.bet.findUnique({ where: { id: input.betId } });
    if (!bet) {
      throw notFound("bet not found");
    }

    if (bet.status !== BET_STATUS.PLACED) {
      throw conflict("only PLACED bets can be settled");
    }

    // Conditional state update makes repeated or concurrent settlement race-safe.
    const stateChange = await tx.bet.updateMany({
      where: { id: bet.id, status: BET_STATUS.PLACED },
      data: {
        status: BET_STATUS.SETTLED,
        result: input.result,
        settledAt: new Date()
      }
    });

    if (stateChange.count === 0) {
      throw conflict("only PLACED bets can be settled");
    }

    let balance: number | undefined;
    let ledgerEntryId: number | undefined;
    if (input.result === "WIN") {
      const payout = bet.amount * 2;
      const updatedUser = await tx.user.update({
        where: { id: bet.userId },
        data: { balance: { increment: payout } }
      });
      const ledger = await appendLedger(tx, {
        userId: bet.userId,
        betId: bet.id,
        type: LEDGER_TYPES.BET_CREDIT,
        amount: payout
      });
      balance = updatedUser.balance;
      ledgerEntryId = ledger.id;
    } else {
      const user = await tx.user.findUniqueOrThrow({ where: { id: bet.userId } });
      balance = user.balance;
    }

    const settledBet = await tx.bet.findUniqueOrThrow({
      where: { id: bet.id }
    });

    return {
      bet: settledBet,
      balance,
      ledgerEntryId
    };
  });
}

export async function cancelBet(input: { betId: number }) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const bet = await tx.bet.findUnique({ where: { id: input.betId } });
    if (!bet) {
      throw notFound("bet not found");
    }

    if (bet.status !== BET_STATUS.PLACED) {
      throw conflict("only PLACED bets can be cancelled");
    }

    // Only a still-PLACED bet can be cancelled; terminal states are rejected.
    const stateChange = await tx.bet.updateMany({
      where: { id: bet.id, status: BET_STATUS.PLACED },
      data: { status: BET_STATUS.CANCELLED }
    });

    if (stateChange.count === 0) {
      throw conflict("only PLACED bets can be cancelled");
    }

    const updatedUser = await tx.user.update({
      where: { id: bet.userId },
      data: { balance: { increment: bet.amount } }
    });

    const ledger = await appendLedger(tx, {
      userId: bet.userId,
      betId: bet.id,
      type: LEDGER_TYPES.BET_REFUND,
      amount: bet.amount
    });

    const cancelledBet = await tx.bet.findUniqueOrThrow({
      where: { id: bet.id }
    });

    return {
      bet: cancelledBet,
      balance: updatedUser.balance,
      ledgerEntryId: ledger.id
    };
  });
}
