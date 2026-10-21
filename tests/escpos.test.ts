import assert from "node:assert/strict";
import test from "node:test";
import { escpos } from "../src/escpos.js";

test("drawer pulse uses documented two millisecond units", () => {
  assert.deepEqual([...escpos.drawerPulse(0, 80)], [0x1b, 0x70, 0x00, 40, 40]);
  assert.throws(() => escpos.drawerPulse(0, 60), /80-200/);
  assert.throws(() => escpos.drawerPulse(0, 220), /80-200/);
});

test("CP437 encoder emits a safe fallback for unsupported characters", () => {
  assert.deepEqual([...escpos.text("Ribs 😀\n")], [82, 105, 98, 115, 32, 63, 10]);
});
