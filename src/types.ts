export type PaymentMethod = "cash" | "mobile_money" | "card" | "other";

export interface ReceiptItem {
  name: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface Receipt {
  saleId: string;
  date: string;
  items: ReceiptItem[];
  subtotal: number;
  total: number;
  paymentMethod: PaymentMethod;
}

export interface PrinterStatus {
  configured: boolean;
  found: boolean;
  state: "not_configured" | "available" | "unavailable" | "error";
  printerName?: string;
  detail?: string;
}

export type HardwareAction = "print_receipt" | "open_drawer";
