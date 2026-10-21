import type { Receipt } from "./types.js";

const ESC = 0x1b;
const GS = 0x1d;

/**
 * S-POS SP-240 U profile: Epson-compatible ESC/POS, Font A width 48 columns,
 * CP437 default. Commands are kept here so HTTP and receipt code never build
 * raw control bytes themselves.
 */
export const SP240_PROFILE = {
  id: "s_pos_sp_240_u",
  columns: 48,
  encoding: "cp437",
} as const;

const cp437Characters: Record<string, number> = {
  "Ç": 0x80, "ü": 0x81, "é": 0x82, "â": 0x83, "ä": 0x84, "à": 0x85, "å": 0x86, "ç": 0x87,
  "ê": 0x88, "ë": 0x89, "è": 0x8a, "ï": 0x8b, "î": 0x8c, "ì": 0x8d, "Ä": 0x8e, "Å": 0x8f,
  "É": 0x90, "æ": 0x91, "Æ": 0x92, "ô": 0x93, "ö": 0x94, "ò": 0x95, "û": 0x96, "ù": 0x97,
  "ÿ": 0x98, "Ö": 0x99, "Ü": 0x9a, "£": 0x9c, "¥": 0x9d, "₧": 0x9e, "ƒ": 0x9f,
};

/** Encodes printable receipt text using the printer's documented PC437 default. */
export function encodeCp437(value: string): Buffer {
  const output: number[] = [];
  for (const character of value.replace(/[\r\n]/g, "\n")) {
    const code = character.codePointAt(0)!;
    if (character === "\n") output.push(0x0a);
    else if (code >= 0x20 && code <= 0x7e) output.push(code);
    else output.push(cp437Characters[character] ?? 0x3f);
  }
  return Buffer.from(output);
}

export const escpos = {
  initialize: () => Buffer.from([ESC, 0x40]), // ESC @
  alignLeft: () => Buffer.from([ESC, 0x61, 0x00]), // ESC a 0
  alignCenter: () => Buffer.from([ESC, 0x61, 0x01]), // ESC a 1
  bold: (enabled: boolean) => Buffer.from([ESC, 0x45, enabled ? 0x01 : 0x00]), // ESC E n
  fontA: () => Buffer.from([ESC, 0x4d, 0x00]), // ESC M 0
  text: encodeCp437,
  lineFeed: (count = 1) => Buffer.alloc(count, 0x0a),
  /** GS V 0: full cut. Physical cutter support is printer/driver dependent. */
  fullCut: () => Buffer.from([GS, 0x56, 0x00]),
  /**
   * ESC p m t1 t2. Epson-compatible timing units are 2 ms. m selects the
   * configured output; t1 is the energised pulse and t2 the recovery period.
   */
  drawerPulse: (output: 0 | 1, pulseMs: number) => {
    const units = Math.round(pulseMs / 2);
    if (units < 40 || units > 100) throw new RangeError("Drawer pulse must be 80-200 ms.");
    return Buffer.from([ESC, 0x70, output, units, units]);
  },
};

export function hardwareTestReceipt(): Receipt {
  return {
    saleId: "HARDWARE-TEST",
    date: new Date().toISOString(),
    items: [
      { name: "Printer: S-POS SP-240 U", quantity: 1, unitPrice: 0, total: 0 },
      { name: "ESC/POS: OK", quantity: 1, unitPrice: 0, total: 0 },
      { name: "USB/Windows Print: OK", quantity: 1, unitPrice: 0, total: 0 },
    ],
    subtotal: 0,
    total: 0,
    paymentMethod: "other",
  };
}
