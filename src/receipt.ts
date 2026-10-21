import { escpos, SP240_PROFILE } from "./escpos.js";
import type { Receipt, ReceiptItem } from "./types.js";

const WIDTH = SP240_PROFILE.columns;
const TRAILING_FEED_LINES = 2;
const ASCII_LOGO = [
  " ______  _____",
  "|  ____|/ ____|",
  "| |__  | (___",
  "|  __|  \\___ \\",
  "| |     ____) |",
  "|_|    |_____/",
  "FIRESTONE SMOKEHOUSE",
];

function clean(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, " ").trim();
}

function wrap(value: string, width = WIDTH): string[] {
  const words = clean(value).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const result: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > width) {
      if (current) result.push(current);
      for (let offset = 0; offset < word.length; offset += width) result.push(word.slice(offset, offset + width));
      current = "";
    } else if (!current) current = word;
    else if (current.length + word.length + 1 <= width) current += ` ${word}`;
    else {
      result.push(current);
      current = word;
    }
  }
  if (current) result.push(current);
  return result;
}

function centred(value: string): string {
  const text = value.slice(0, WIDTH);
  return " ".repeat(Math.max(0, Math.floor((WIDTH - text.length) / 2))) + text;
}

function twoColumns(left: string, right: string): string {
  const gap = WIDTH - left.length - right.length;
  if (gap < 1) return `${left.slice(0, Math.max(1, WIDTH - right.length - 1))} ${right}`;
  return `${left}${" ".repeat(gap)}${right}`;
}

function ugx(value: number): string {
  return `UGX ${Math.round(value).toLocaleString("en-US")}`;
}

function quantity(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, "");
}

function itemLines(item: ReceiptItem): string[] {
  const line = `${quantity(item.quantity)} x ${ugx(item.unitPrice)}`;
  return [...wrap(item.name), twoColumns(line, ugx(item.total))];
}

/** Formats only structured data into a safe 48-column Font A receipt and appends a full cut. */
export function buildReceipt(receipt: Receipt): Buffer {
  const date = new Date(receipt.date);
  const when = Number.isNaN(date.valueOf()) ? receipt.date : date.toLocaleString("en-UG", { hour12: false });
  const body = [
    "FIRESTONE SMOKEHOUSE",
    "",
    `Sale: ${clean(receipt.saleId)}`,
    `Date: ${when}`,
    "-".repeat(WIDTH),
    ...receipt.items.flatMap(itemLines),
    "-".repeat(WIDTH),
    twoColumns("Subtotal", ugx(receipt.subtotal)),
    twoColumns("TOTAL", ugx(receipt.total)),
    `Payment: ${clean(receipt.paymentMethod).replace(/_/g, " ")}`,
    "",
    "Thank you for choosing Firestone Smokehouse.",
  ];

  return Buffer.concat([
    escpos.initialize(),
    escpos.fontA(),
    escpos.alignLeft(),
    escpos.bold(true),
    escpos.text(`${ASCII_LOGO.join("\n")}\n`),
    escpos.bold(false),
    escpos.text(`${body.slice(1).join("\n")}\n`),
    escpos.lineFeed(TRAILING_FEED_LINES),
    escpos.fullCut(),
  ]);
}

/** A realistic receipt-layout sample that never represents a committed sale. */
export function buildSampleSaleReceipt(): Buffer {
  return buildReceipt({
    saleId: "SAMPLE - NOT A SALE",
    date: new Date().toISOString(),
    items: [
      { name: "Bottled mineral water", quantity: 1, unitPrice: 2_000, total: 2_000 },
    ],
    subtotal: 2_000,
    total: 2_000,
    paymentMethod: "cash",
  });
}

/** The requested physical test layout; it is deliberately not a sale receipt. */
export function buildHardwareTestReceipt(): Buffer {
  const lines = [
    "POS HARDWARE TEST",
    "",
    "Printer: S-POS SP-240 U",
    "ESC/POS: OK",
    "USB/Windows Print: OK",
    "",
    "If you can read this,",
    "receipt printing is working.",
    "",
    "-".repeat(WIDTH),
    "HARDWARE TEST - NOT A SALE",
  ];
  return Buffer.concat([
    escpos.initialize(),
    escpos.fontA(),
    escpos.alignLeft(),
    escpos.bold(true),
    escpos.text(`${ASCII_LOGO.join("\n")}\n`),
    escpos.bold(false),
    escpos.alignCenter(),
    escpos.text(`\n${lines.map(centred).join("\n")}\n`),
    escpos.lineFeed(TRAILING_FEED_LINES),
    escpos.fullCut(),
  ]);
}
