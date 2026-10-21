import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { BridgeConfig } from "./config.js";
import { BridgeError } from "./errors.js";
import type { HardwareAction } from "./types.js";

const encoder = new TextEncoder();

export type HardwareAuthorization = {
  posAction?: { actionId: string; receiptHash: string };
  onlineReceiptPrintJob?: {
    jobId: string;
    orderId: string;
    receiptHash: string;
  };
};

export class HardwareAuthorizer {
  private readonly usedDrawerTokens = new Map<string, number>();
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: BridgeConfig) {
    if (config.authMode === "jwks" && config.jwksUrl) this.jwks = createRemoteJWKSet(new URL(config.jwksUrl));
    const cleanup = setInterval(() => this.pruneUsedTokens(), 60_000);
    cleanup.unref();
  }

  async authorize(request: Request, expectedAction: HardwareAction, saleId: string): Promise<HardwareAuthorization> {
    const header = request.header("authorization");
    if (!header?.startsWith("Bearer ")) throw new BridgeError("invalid_authorization", "A hardware authorization token is required.", 401);
    const token = header.slice("Bearer ".length).trim();
    if (!token) throw new BridgeError("invalid_authorization", "A hardware authorization token is required.", 401);

    try {
      const verification = this.config.authMode === "development"
        ? await jwtVerify(token, encoder.encode(this.config.devSecret), { algorithms: ["HS256"], issuer: this.config.issuer, audience: this.config.audience })
        : await jwtVerify(token, this.jwks!, { algorithms: ["EdDSA"], issuer: this.config.issuer, audience: this.config.audience });
      const action = verification.payload.action;
      const tokenSaleId = verification.payload.sale_id;
      const jti = verification.payload.jti;
      if (action !== expectedAction || tokenSaleId !== saleId || typeof jti !== "string" || jti.length < 8) {
        throw new BridgeError("invalid_authorization", "Authorization is not valid for this hardware action and sale.", 403);
      }
      const posActionId = verification.payload.pos_action_id;
      if (posActionId !== undefined) {
        const hash = verification.payload.receipt_hash;
        const kind = expectedAction === "open_drawer" ? "drawer" : "receipt";
        if (typeof posActionId !== "string" || typeof hash !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(hash) ||
          !new RegExp("^pos:[0-9]+:" + kind + ":" + (kind === "drawer" ? "original" : "(?:original|[0-9a-f-]{36})") + "$").test(posActionId))
          throw new BridgeError("invalid_authorization", "Invalid walk-in hardware action scope.", 403);
        // Replay control for this scope is durable in PosActionStore, not token jti.
        return { posAction: { actionId: posActionId, receiptHash: hash } };
      }
      if (expectedAction === "open_drawer") {
        const expiresAt = (verification.payload.exp ?? Math.floor(Date.now() / 1000) + 120) * 1000;
        if (this.usedDrawerTokens.has(jti)) throw new BridgeError("authorization_replayed", "This drawer authorization was already used.", 409);
        // Consume before the pulse: a retry after an uncertain spooler result needs a new backend authorization.
        this.usedDrawerTokens.set(jti, expiresAt);
      }
      if (expectedAction === "print_receipt") {
        const jobId = verification.payload.print_job_id;
        const orderId = verification.payload.order_id;
        const receiptHash = verification.payload.receipt_hash;
        const hasOnlineReceiptClaim = jobId !== undefined || orderId !== undefined || receiptHash !== undefined;
        if (!hasOnlineReceiptClaim) return {};
        if (
          typeof jobId !== "string"
          || typeof orderId !== "string"
          || !/^\d+$/.test(orderId)
          || typeof receiptHash !== "string"
          || !/^[A-Za-z0-9_-]{43}$/.test(receiptHash)
        ) {
          throw new BridgeError("invalid_authorization", "Online receipt authorization claims are invalid.", 403);
        }
        return { onlineReceiptPrintJob: { jobId, orderId, receiptHash } };
      }
      return {};
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("invalid_authorization", "Hardware authorization could not be verified.", 401);
    }
  }

  async createDevelopmentToken(action: HardwareAction, saleId: string): Promise<string> {
    if (this.config.authMode !== "development") throw new Error("Development token generation is only available when AUTH_MODE=development.");
    return new SignJWT({ action, sale_id: saleId })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setIssuer(this.config.issuer)
      .setAudience(this.config.audience)
      .setJti(randomUUID())
      .setExpirationTime("2m")
      .sign(encoder.encode(this.config.devSecret));
  }

  private pruneUsedTokens(): void {
    const now = Date.now();
    for (const [jti, expiresAt] of this.usedDrawerTokens) if (expiresAt <= now) this.usedDrawerTokens.delete(jti);
  }
}
