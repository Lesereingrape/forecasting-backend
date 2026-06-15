import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { conflict } from "../errors.js";

type IdempotentResult<T> = {
  statusCode: number;
  body: T;
  replayed: boolean;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function hashRequest(body: unknown): string {
  return createHash("sha256").update(stableJson(body)).digest("hex");
}

// Runs business logic once per scope/key pair and replays the first response on retries.
export async function withIdempotency<T>(
  tx: Prisma.TransactionClient,
  scope: string,
  key: string,
  requestBody: unknown,
  execute: () => Promise<{ statusCode: number; body: T }>
): Promise<IdempotentResult<T>> {
  // Sort object keys before hashing so semantically equal JSON gets the same hash.
  const requestHash = hashRequest(requestBody);
  const existing = await tx.idempotencyRecord.findUnique({
    where: { key_scope: { key, scope } }
  });

  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw conflict("Idempotency-Key was already used with a different request body");
    }

    // Returning the stored response keeps client retries deterministic.
    return {
      statusCode: existing.statusCode,
      body: JSON.parse(existing.responseBody) as T,
      replayed: true
    };
  }

  const result = await execute();
  // This write is in the caller's transaction, together with balance and ledger changes.
  await tx.idempotencyRecord.create({
    data: {
      key,
      scope,
      requestHash,
      statusCode: result.statusCode,
      responseBody: JSON.stringify(result.body)
    }
  });

  return { ...result, replayed: false };
}
