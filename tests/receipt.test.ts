import assert from "node:assert/strict";
import test from "node:test";
import { buildReceipt, buildSampleSaleReceipt } from "../src/receipt.js";

test("receipt output initializes, contains receipt text, feeds, and cuts", () => {
  const output = buildReceipt({
    saleId: "POS-000184",
    date: "2026-08-16T10:20:00+03:00",
    items: [{ name: "Smoked Beef Ribs", quantity: 1, unitPrice: 50_000, total: 50_000 }],
    subtotal: 50_000,
    total: 50_000,
    paymentMethod: "cash",
  });
  assert.deepEqual([...output.subarray(0, 2)], [0x1b, 0x40]);
  assert.match(output.toString("latin1"), /\|  ____\|\/ ____\|/);
  assert.ok(output.indexOf("FIRESTONE SMOKEHOUSE") < output.indexOf("POS-000184"));
  assert.match(output.toString("latin1"), /POS-000184/);
  assert.deepEqual([...output.subarray(-5)], [0x0a, 0x0a, 0x1d, 0x56, 0x00]);
});

test("sample sale receipt uses bottled water without posing as a sale", () => {
  const output = buildSampleSaleReceipt().toString("latin1");
  assert.match(output, /SAMPLE - NOT A SALE/);
  assert.match(output, /Bottled mineral water/);
  assert.match(output, /1 x UGX 2,000\s+UGX 2,000/);
  assert.match(output, /TOTAL\s+UGX 2,000/);
});
