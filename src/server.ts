import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import path from "node:path";
import { z } from "zod";
import { HardwareAuthorizer } from "./auth.js";
import { loadConfig } from "./config.js";
import { BridgeError } from "./errors.js";
import { createLogger } from "./logger.js";
import { WindowsRawPosPrinter } from "./printer.js";
import { receiptFingerprint } from "./receipt-fingerprint.js";
import { PosActionStore } from "./pos-action-store.js";
import { createPosActionsRouter } from "./pos-actions-router.js";
import { ReceiptJobCollisionError, ReceiptJobStore } from "./receipt-job-store.js";

const receiptSchema = z.object({
  saleId: z.string().trim().min(1).max(80),
  date: z.string().datetime({ offset: true }),
  items: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    quantity: z.number().positive().max(10_000),
    unitPrice: z.number().nonnegative().max(100_000_000),
    total: z.number().nonnegative().max(100_000_000),
  })).min(1).max(100),
  subtotal: z.number().nonnegative().max(100_000_000),
  total: z.number().nonnegative().max(100_000_000),
  paymentMethod: z.enum(["cash", "mobile_money", "card", "other"]),
}).strict();

const drawerSchema = z.object({ saleId: z.string().trim().min(1).max(80) }).strict();

const config = loadConfig();
const logger = createLogger(config);
const printer = new WindowsRawPosPrinter(config, logger);
const authorizer = new HardwareAuthorizer(config);
const receiptJobs = new ReceiptJobStore(path.join(config.projectRoot, "data", "receipt-print-jobs.json"));
const posActions = new PosActionStore(path.join(config.projectRoot, "data", "pos-actions-v1"));
const drawerLimit = rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: "draft-8", legacyHeaders: false });
const app = express();
const corsOptions = {
  origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
    callback(null, origin === config.allowedOrigin);
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  maxAge: 600,
};

app.disable("x-powered-by");
// Browser POST requests include Authorization, so answer their CORS preflight
// before the normal routes and rate limiter handle the request.
app.options(/.*/, cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json({ limit: config.maxRequestBytes, strict: true, type: "application/json" }));
app.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false }));

function requireAllowedOrigin(request: Request, _response: Response, next: NextFunction): void {
  const origin = request.header("origin");
  if (!origin) return next(new BridgeError("origin_missing", "Mutation requests must include the configured browser Origin.", 403));
  if (origin !== config.allowedOrigin) return next(new BridgeError("origin_rejected", "This browser origin is not allowed to operate the bridge.", 403));
  next();
}

const offlineEnabled = process.env.OFFLINE_POS_ENABLED === "true";
const offline = offlineEnabled ? await (await import("./offline/runtime.js")).startOffline(config, printer, error => logger.error({ err: error }, "Offline POS error")) : null;
if (offline) app.use("/offline", offline.router);

app.get("/health", (_request, response) => {
  response.json({ ok: true, service: "smokehouse-pos-bridge", version: "0.2.1", capabilities: ["walk_in_pos_actions_v1", ...(offline ? ["offline_cash_pos_v1"] : [])] });
});

app.get("/printer/status", async (_request, response, next) => {
  try {
    response.json({ ok: true, printer: await printer.getStatus() });
  } catch (error) {
    next(error);
  }
});

app.use("/pos", createPosActionsRouter({ authorizer, store: posActions, printer, logger, requireOrigin: requireAllowedOrigin, drawerLimit, receiptSchema }));

app.post("/receipt/print", requireAllowedOrigin, async (request, response, next) => {
  const parsed = receiptSchema.safeParse(request.body);
  if (!parsed.success) return next(new BridgeError("invalid_request", "Receipt data is invalid.", 422, { issues: parsed.error.issues.map((issue) => issue.path.join(".")) }));
  try {
    const authorization = await authorizer.authorize(request, "print_receipt", parsed.data.saleId);
    if (authorization.posAction) throw new BridgeError("invalid_authorization", "Use the durable walk-in endpoint for this action.", 403);
    const requestJobId = request.header("idempotency-key");
    const onlineReceiptJob = authorization.onlineReceiptPrintJob;
    if (!onlineReceiptJob && requestJobId) {
      throw new BridgeError("invalid_authorization", "This receipt authorization is not valid for an idempotent online print job.", 403);
    }
    if (onlineReceiptJob) {
      if (!requestJobId || requestJobId !== onlineReceiptJob.jobId) {
        throw new BridgeError("invalid_authorization", "The receipt print job ID does not match its authorization.", 403);
      }
      if (!z.string().uuid().safeParse(requestJobId).success) {
        throw new BridgeError("invalid_request", "The receipt print job ID must be a UUID.", 422);
      }
      if (receiptFingerprint(parsed.data) !== onlineReceiptJob.receiptHash) {
        throw new BridgeError("invalid_authorization", "The receipt data does not match its authorization.", 403);
      }

      const reservation = await receiptJobs.reserve({
        jobId: requestJobId,
        saleId: parsed.data.saleId,
        receiptFingerprint: onlineReceiptJob.receiptHash,
      });
      if (!reservation.isNew) {
        if (reservation.record.state === "uncertain") {
          throw new BridgeError("print_job_uncertain", "This print job was accepted but its prior spool result was uncertain. Create an explicit new reprint job instead.", 409);
        }
        response.status(202).json({ ok: true, jobId: requestJobId, saleId: parsed.data.saleId, status: reservation.record.state === "spooled" ? "queued" : "accepted" });
        return;
      }

      try {
        await printer.printReceipt(parsed.data);
        await receiptJobs.markSpooled(requestJobId);
      } catch (error) {
        await receiptJobs.markUncertain(requestJobId, error instanceof Error ? error.message : "spool_submission_failed");
        throw error;
      }
      logger.info({ saleId: parsed.data.saleId, jobId: requestJobId, orderId: onlineReceiptJob.orderId }, "Idempotent receipt print request succeeded");
      response.status(202).json({ ok: true, jobId: requestJobId, saleId: parsed.data.saleId, status: "queued" });
      return;
    }
    await printer.printReceipt(parsed.data);
    logger.info({ saleId: parsed.data.saleId }, "Receipt print request succeeded");
    response.status(202).json({ ok: true, saleId: parsed.data.saleId, status: "queued" });
  } catch (error) {
    logger.warn({ err: error, saleId: parsed.data.saleId }, "Receipt print request failed");
    next(error);
  }
});

app.post("/drawer/open", requireAllowedOrigin, drawerLimit, async (request, response, next) => {
  const parsed = drawerSchema.safeParse(request.body);
  if (!parsed.success) return next(new BridgeError("invalid_request", "Drawer request data is invalid.", 422));
  try {
    const authorization = await authorizer.authorize(request, "open_drawer", parsed.data.saleId);
    if (authorization.posAction) throw new BridgeError("invalid_authorization", "Use the durable walk-in endpoint for this action.", 403);
    await printer.openDrawer();
    logger.info({ saleId: parsed.data.saleId }, "Drawer open request succeeded");
    response.status(202).json({ ok: true, saleId: parsed.data.saleId, status: "queued" });
  } catch (error) {
    logger.warn({ err: error, saleId: parsed.data.saleId }, "Drawer open request failed");
    next(error);
  }
});

app.use((_request, response) => response.status(404).json({ ok: false, error: { code: "invalid_request", message: "Route not found." } }));
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof BridgeError) {
    response.status(error.status).json({ ok: false, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    return;
  }
  if (error instanceof SyntaxError && "body" in error) {
    response.status(400).json({ ok: false, error: { code: "invalid_request", message: "Request body must be valid JSON." } });
    return;
  }
  logger.error({ err: error }, "Unhandled bridge request error");
  response.status(500).json({ ok: false, error: { code: "internal_error", message: "Unexpected bridge error." } });
});

const server = app.listen(config.port, "127.0.0.1", () => {
  logger.info({ address: `127.0.0.1:${config.port}`, allowedOrigin: config.allowedOrigin, authMode: config.authMode }, "Bridge started");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "Bridge shutting down");
  server.close(() => { offline?.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
