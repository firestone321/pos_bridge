import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type pino from "pino";
import type { HardwareAuthorizer } from "./auth.js";
import { BridgeError } from "./errors.js";
import { PosActionStore, type PosAction } from "./pos-action-store.js";
import type { PosPrinter } from "./printer.js";
import type { Receipt } from "./types.js";
import { receiptFingerprint } from "./receipt-fingerprint.js";

export function createPosActionsRouter(deps: {
  authorizer: Pick<HardwareAuthorizer, "authorize">; store: PosActionStore; printer: PosPrinter;
  logger: pino.Logger; requireOrigin: RequestHandler; drawerLimit: RequestHandler; receiptSchema: z.ZodType<Receipt>;
}) {
  const router = Router();
  const common = z.object({ saleId: z.string().min(1).max(80), actionId: z.string().min(1).max(120) });
  router.use(deps.requireOrigin);
  async function authorize(request: Parameters<HardwareAuthorizer["authorize"]>[0], kind: "drawer" | "receipt", body: {saleId: string; actionId: string}): Promise<PosAction> {
    const start = performance.now();
    const authorization = await deps.authorizer.authorize(request, kind === "drawer" ? "open_drawer" : "print_receipt", body.saleId);
    if (!authorization.posAction || authorization.posAction.actionId !== body.actionId)
      throw new BridgeError("invalid_authorization", "A scoped walk-in POS action authorization is required.", 403);
    deps.logger.info({ event: "pos_hardware_timing", actionId: body.actionId, stage: "authorization_verified", elapsedMs: performance.now()-start });
    return { ...body, kind, receiptHash: authorization.posAction.receiptHash };
  }
  router.post("/actions/status", async (request, response, next) => {
    try {
      const body = common.extend({ kind: z.enum(["drawer", "receipt"]) }).strict().parse(request.body);
      const action = await authorize(request, body.kind, body);
      response.json({ ok: true, status: await deps.store.status(action) });
    } catch (error) { next(error instanceof z.ZodError ? new BridgeError("invalid_request", "Invalid action status request.", 422) : error); }
  });
  for (const kind of ["drawer", "receipt"] as const) {
    router.post(kind === "drawer" ? "/drawer/open" : "/receipt/print", ...(kind === "drawer" ? [deps.drawerLimit] : []), async (request, response, next) => {
      try {
        const body = (kind === "drawer" ? common.strict() : common.extend({ receipt: deps.receiptSchema }).strict()).parse(request.body);
        const action = await authorize(request, kind, body);
        let receipt: Receipt | undefined;
        if (kind === "receipt") {
          receipt = deps.receiptSchema.parse(request.body.receipt);
          if (receipt.saleId !== action.saleId || receiptFingerprint(receipt) !== action.receiptHash)
            throw new BridgeError("invalid_authorization", "Receipt does not match its signed snapshot.", 403);
        }
        const result = await deps.store.execute(action, () => kind === "drawer"
          ? deps.printer.openDrawer({ actionId: action.actionId })
          : deps.printer.printReceipt(receipt!, { actionId: action.actionId }));
        deps.logger.info({ event: "pos_hardware_submitted", actionId: action.actionId, duplicate: result.duplicate });
        response.status(202).json({ ok: true, ...result });
      } catch (error) { next(error instanceof z.ZodError ? new BridgeError("invalid_request", "Invalid POS hardware request.", 422) : error); }
    });
  }
  return router;
}
