import { createHash } from "node:crypto";
import { z } from "zod";

export class OfflineError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
const integer = z.number().int().min(1).max(100_000_000);
const resource = z.object({ resourceId: integer, quantity: integer }).strict();
export const grantSchema = z.object({
  version: z.literal(1), grantId: z.uuid(), terminalId: z.uuid(), epoch: z.uuid(),
  terminalKey: z.string().min(40).max(100), cashierId: z.uuid(),
  permissions: z.array(z.enum(["cash", "reprint"])).min(1),
  allocationId: z.uuid(), catalogVersion: z.uuid(), serviceDate: z.iso.date(),
  issuedAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
  items: z.array(z.object({
    menuItemId: integer, name: z.string().min(1).max(120), unitPrice: integer,
    requirements: z.array(resource).min(1).max(30)
  }).strict()).min(1).max(100),
  budgets: z.array(resource).min(1).max(100)
}).strict();
export type Grant = z.infer<typeof grantSchema>;
export const cashInputSchema = z.object({
  transactionId: z.uuid(), catalogVersion: z.uuid(), expectedTotal: integer,
  amountReceived: integer,
  items: z.array(z.object({ menuItemId: integer, quantity: z.number().int().min(1).max(20) }).strict()).min(1).max(100)
}).strict();
export type CashInput = z.infer<typeof cashInputSchema>;
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key,v]) => JSON.stringify(key) + ":" + canonical(v)).join(",") + "}";
}
export function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("base64url"); }
export function normalizeInput(value: unknown): CashInput {
  const input = cashInputSchema.parse(value);
  if (new Set(input.items.map(i => i.menuItemId)).size !== input.items.length)
    throw new OfflineError("duplicate_line", "Merge duplicate basket lines before committing.");
  return { ...input, transactionId:input.transactionId.toLowerCase(),catalogVersion:input.catalogVersion.toLowerCase(), items: input.items.sort((a,b) => a.menuItemId-b.menuItemId) };
}
export function validateGrant(value: unknown, now: number): Grant {
  const grant = grantSchema.parse(value);
  if (grant.issuedAt > now + 30_000 || grant.expiresAt <= now || grant.expiresAt <= grant.issuedAt ||
      grant.expiresAt - grant.issuedAt > 24*60*60*1000 || !grant.permissions.includes("cash"))
    throw new OfflineError("grant_expired", "A current offline cash authorization is required.", 403);
  if (new Set(grant.items.map(i=>i.menuItemId)).size !== grant.items.length ||
      new Set(grant.budgets.map(i=>i.resourceId)).size !== grant.budgets.length ||
      grant.items.some(i => new Set(i.requirements.map(r=>r.resourceId)).size !== i.requirements.length ||
        i.requirements.some(r => !grant.budgets.some(b=>b.resourceId===r.resourceId))))
    throw new OfflineError("invalid_catalog", "Catalog requirements must reference unique funded resources.", 403);
  return grant;
}
export function kampalaDate(now: number): string {
  return new Date(now + 3*60*60*1000).toISOString().slice(0,10);
}
