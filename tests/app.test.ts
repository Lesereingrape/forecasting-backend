import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db.js";
import { ensureDatabaseSchema } from "../src/dbSchema.js";

const app = createApp();

async function ensureSchema() {
  await ensureDatabaseSchema(prisma);
}

async function resetData() {
  await ensureSchema();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.bet.deleteMany();
  await prisma.user.deleteMany();

  await prisma.user.create({
    data: { id: 1, username: "alice", balance: 1000 }
  });
  await prisma.ledgerEntry.create({
    data: { userId: 1, type: "DEPOSIT", amount: 1000 }
  });
}

beforeEach(async () => {
  await resetData();
});

describe("forecasting backend", () => {
  it("increases balance after a successful deposit", async () => {
    const res = await request(app)
      .post("/api/users/1/deposit")
      .set("Idempotency-Key", "deposit-1")
      .send({ amount: 200 });

    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(1200);
  });

  it("applies the same deposit idempotency key only once", async () => {
    await request(app)
      .post("/api/users/1/deposit")
      .set("Idempotency-Key", "deposit-2")
      .send({ amount: 200 })
      .expect(200);

    const replay = await request(app)
      .post("/api/users/1/deposit")
      .set("Idempotency-Key", "deposit-2")
      .send({ amount: 200 });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: 1 } });
    expect(replay.status).toBe(200);
    expect(replay.header["idempotency-replayed"]).toBe("true");
    expect(user.balance).toBe(1200);
  });

  it("returns 409 when the same idempotency key is reused with a different amount", async () => {
    await request(app)
      .post("/api/users/1/deposit")
      .set("Idempotency-Key", "deposit-3")
      .send({ amount: 200 })
      .expect(200);

    await request(app)
      .post("/api/users/1/deposit")
      .set("Idempotency-Key", "deposit-3")
      .send({ amount: 201 })
      .expect(409);
  });

  it("rejects a bet when balance is insufficient", async () => {
    await request(app)
      .post("/api/bets")
      .set("Idempotency-Key", "bet-too-large")
      .send({ userId: 1, gameId: "game-a", amount: 1001 })
      .expect(409);
  });

  it("places a bet idempotently and debits balance once", async () => {
    const first = await request(app)
      .post("/api/bets")
      .set("Idempotency-Key", "bet-1")
      .send({ userId: 1, gameId: "game-a", amount: 300 });

    const replay = await request(app)
      .post("/api/bets")
      .set("Idempotency-Key", "bet-1")
      .send({ userId: 1, gameId: "game-a", amount: 300 });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: 1 } });
    const bets = await prisma.bet.findMany();

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.header["idempotency-replayed"]).toBe("true");
    expect(user.balance).toBe(700);
    expect(bets).toHaveLength(1);
  });

  it("credits payout when a bet settles as WIN", async () => {
    const placed = await request(app)
      .post("/api/bets")
      .set("Idempotency-Key", "bet-win")
      .send({ userId: 1, gameId: "game-a", amount: 100 });

    const settled = await request(app)
      .post(`/api/bets/${placed.body.bet.id}/settle`)
      .send({ result: "WIN" });

    expect(settled.status).toBe(200);
    expect(settled.body.balance).toBe(1100);
    expect(settled.body.bet.status).toBe("SETTLED");
  });

  it("does not allow a settled bet to be settled again", async () => {
    const placed = await request(app)
      .post("/api/bets")
      .set("Idempotency-Key", "bet-repeat-settle")
      .send({ userId: 1, gameId: "game-a", amount: 100 });

    await request(app)
      .post(`/api/bets/${placed.body.bet.id}/settle`)
      .send({ result: "LOSE" })
      .expect(200);

    await request(app)
      .post(`/api/bets/${placed.body.bet.id}/settle`)
      .send({ result: "WIN" })
      .expect(409);
  });

  it("allows only one concurrent bet when combined debits exceed balance", async () => {
    const requests = await Promise.all([
      request(app)
        .post("/api/bets")
        .set("Idempotency-Key", "concurrent-bet-a")
        .send({ userId: 1, gameId: "game-a", amount: 700 }),
      request(app)
        .post("/api/bets")
        .set("Idempotency-Key", "concurrent-bet-b")
        .send({ userId: 1, gameId: "game-b", amount: 700 })
    ]);

    const statuses = requests.map((res) => res.status).sort();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: 1 } });
    const bets = await prisma.bet.findMany();
    const debits = await prisma.ledgerEntry.findMany({
      where: { type: "BET_DEBIT" }
    });

    expect(statuses).toEqual([201, 409]);
    expect(user.balance).toBe(300);
    expect(bets).toHaveLength(1);
    expect(debits).toHaveLength(1);
  });

  it("allows only one concurrent settlement for the same bet", async () => {
    const placed = await request(app)
      .post("/api/bets")
      .set("Idempotency-Key", "concurrent-settle-bet")
      .send({ userId: 1, gameId: "game-a", amount: 100 });

    const requests = await Promise.all([
      request(app)
        .post(`/api/bets/${placed.body.bet.id}/settle`)
        .send({ result: "WIN" }),
      request(app)
        .post(`/api/bets/${placed.body.bet.id}/settle`)
        .send({ result: "WIN" })
    ]);

    const statuses = requests.map((res) => res.status).sort();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: 1 } });
    const credits = await prisma.ledgerEntry.findMany({
      where: { type: "BET_CREDIT" }
    });

    expect(statuses).toEqual([200, 409]);
    expect(user.balance).toBe(1100);
    expect(credits).toHaveLength(1);
  });

  it("refunds balance when a placed bet is cancelled", async () => {
    const placed = await request(app)
      .post("/api/bets")
      .set("Idempotency-Key", "bet-cancel")
      .send({ userId: 1, gameId: "game-a", amount: 250 });

    const cancelled = await request(app)
      .post(`/api/bets/${placed.body.bet.id}/cancel`);

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.balance).toBe(1000);
    expect(cancelled.body.bet.status).toBe("CANCELLED");
  });

  it("does not allow a cancelled bet to be settled", async () => {
    const placed = await request(app)
      .post("/api/bets")
      .set("Idempotency-Key", "cancel-then-settle")
      .send({ userId: 1, gameId: "game-a", amount: 250 });

    await request(app)
      .post(`/api/bets/${placed.body.bet.id}/cancel`)
      .expect(200);

    await request(app)
      .post(`/api/bets/${placed.body.bet.id}/settle`)
      .send({ result: "WIN" })
      .expect(409);
  });

  it("reports reconciliation data and no anomalies for a valid ledger", async () => {
    const placed = await request(app)
      .post("/api/bets")
      .set("Idempotency-Key", "bet-reconcile")
      .send({ userId: 1, gameId: "game-a", amount: 100 });

    await request(app)
      .post(`/api/bets/${placed.body.bet.id}/settle`)
      .send({ result: "WIN" })
      .expect(200);

    const res = await request(app).get("/api/admin/reconcile?userId=1");

    expect(res.status).toBe(200);
    expect(res.body.storedBalance).toBe(1100);
    expect(res.body.calculatedBalance).toBe(1100);
    expect(res.body.betStatusCounts.SETTLED).toBe(1);
    expect(res.body.anomalies).toEqual([]);
  });
});
