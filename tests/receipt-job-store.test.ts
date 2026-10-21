import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { receiptFingerprint } from "../src/receipt-fingerprint.js";
import { ReceiptJobCollisionError, ReceiptJobStore } from "../src/receipt-job-store.js";

const receipt = {
  saleId: "ORD-1001",
  date: "2026-08-20T10:20:00+03:00",
  items: [{ name: "Goat ribs", quantity: 1, unitPrice: 50_000, total: 50_000 }],
  subtotal: 50_000,
  total: 50_000,
  paymentMethod: "other" as const,
};

test("receipt job ledger survives a restart and suppresses a duplicate job", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "smokehouse-receipt-jobs-"));
  const filePath = path.join(directory, "data", "receipt-print-jobs.json");
  const fingerprint = receiptFingerprint(receipt);
  try {
    const firstStore = new ReceiptJobStore(filePath);
    const first = await firstStore.reserve({ jobId: "ed589f6d-a573-4aa4-9d2a-47d008bd42dd", saleId: receipt.saleId, receiptFingerprint: fingerprint });
    assert.equal(first.isNew, true);
    await firstStore.markSpooled(first.record.jobId);

    const restartedStore = new ReceiptJobStore(filePath);
    const retry = await restartedStore.reserve({ jobId: first.record.jobId, saleId: receipt.saleId, receiptFingerprint: fingerprint });
    assert.equal(retry.isNew, false);
    assert.equal(retry.record.state, "spooled");
    await assert.rejects(
      restartedStore.reserve({ jobId: first.record.jobId, saleId: receipt.saleId, receiptFingerprint: "different-receipt" }),
      ReceiptJobCollisionError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
