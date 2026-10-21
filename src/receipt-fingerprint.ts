import { createHash } from "node:crypto";
import type { Receipt } from "./types.js";

/**
 * Hashes only the structured receipt fields in a fixed order. This is shared
 * with the admin signer contract; do not hash JSON as received from the wire.
 */
export function receiptFingerprint(receipt: Receipt): string {
  const canonicalReceipt = {
    saleId: receipt.saleId,
    date: receipt.date,
    items: receipt.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: item.total,
    })),
    subtotal: receipt.subtotal,
    total: receipt.total,
    paymentMethod: receipt.paymentMethod,
  };

  return createHash("sha256").update(JSON.stringify(canonicalReceipt), "utf8").digest("base64url");
}
