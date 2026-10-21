import assert from "node:assert/strict";
import test from "node:test";
import { receiptFingerprint } from "../src/receipt-fingerprint.js";

test("receipt fingerprint is stable for the canonical online receipt structure", () => {
  const fingerprint = receiptFingerprint({
    saleId: "ORD-1001",
    date: "2026-08-20T10:20:00+03:00",
    items: [{ name: "Goat ribs", quantity: 1, unitPrice: 50_000, total: 50_000 }],
    subtotal: 50_000,
    total: 50_000,
    paymentMethod: "other",
  });
  assert.equal(fingerprint, "hh57Sw_2id44tPjZfOYgUKGd6UskLp4ss8Wap0qnqoI");
});
