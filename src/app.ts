import express, { type NextFunction, type Request, type Response } from "express";
import { AppError, badRequest, notFound } from "./errors.js";
import { depositUser } from "./services/userService.js";
import { cancelBet, placeBet, settleBet } from "./services/betService.js";
import { reconcileUser } from "./services/reconcileService.js";

function requireIdempotencyKey(req: Request): string {
  const key = req.header("Idempotency-Key");
  if (!key) {
    throw badRequest("Idempotency-Key header is required");
  }
  return key;
}

function parseId(value: string | undefined, name: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest(`${name} must be a positive integer`);
  }
  return id;
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/users/:id/deposit", asyncRoute(async (req, res) => {
    const result = await depositUser({
      userId: parseId(req.params.id, "user id"),
      amount: req.body.amount,
      idempotencyKey: requireIdempotencyKey(req)
    });

    if (result.replayed) {
      res.setHeader("Idempotency-Replayed", "true");
    }
    res.status(result.statusCode).json(result.body);
  }));

  app.post("/api/bets", asyncRoute(async (req, res) => {
    const result = await placeBet({
      userId: req.body.userId,
      gameId: req.body.gameId,
      amount: req.body.amount,
      idempotencyKey: requireIdempotencyKey(req)
    });

    if (result.replayed) {
      res.setHeader("Idempotency-Replayed", "true");
    }
    res.status(result.statusCode).json(result.body);
  }));

  app.post("/api/bets/:id/settle", asyncRoute(async (req, res) => {
    const result = await settleBet({
      betId: parseId(req.params.id, "bet id"),
      result: req.body.result
    });
    res.json(result);
  }));

  app.post("/api/bets/:id/cancel", asyncRoute(async (req, res) => {
    const result = await cancelBet({
      betId: parseId(req.params.id, "bet id")
    });
    res.json(result);
  }));

  app.get("/api/admin/reconcile", asyncRoute(async (req, res) => {
    const userId = parseId(String(req.query.userId ?? ""), "userId");
    const result = await reconcileUser(userId);
    if (!result) {
      throw notFound("user not found");
    }
    res.json(result);
  }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.code, message: err.message });
      return;
    }

    res.status(500).json({ error: "INTERNAL_ERROR", message: "internal server error" });
  });

  return app;
}
