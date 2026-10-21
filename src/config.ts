import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const integerFromEnv = (fallback: number) =>
  z.coerce.number().int().finite().default(fallback);

const environmentSchema = z.object({
  PORT: integerFromEnv(17891).pipe(z.number().min(1024).max(65535)),
  ALLOWED_ORIGIN: z.url().refine((value) => !value.endsWith("/"), {
    message: "must not end with a slash",
  }),
  PRINTER_NAME: z.string().trim().default(""),
  PRINTER_PROFILE: z.literal("s_pos_sp_240_u").default("s_pos_sp_240_u"),
  DRAWER_PIN: z.coerce.number().int().pipe(z.union([z.literal(0), z.literal(1)])).default(0),
  DRAWER_PULSE_MS: integerFromEnv(80).pipe(z.number().min(80).max(200)),
  DRAWER_COOLDOWN_MS: integerFromEnv(1000).pipe(z.number().min(800).max(60_000)),
  AUTH_MODE: z.enum(["development", "jwks"]).default("development"),
  BRIDGE_DEV_SECRET: z.string().optional(),
  BRIDGE_ISSUER: z.string().trim().min(1).default("firestone-smokehouse"),
  BRIDGE_AUDIENCE: z.string().trim().min(1).default("smokehouse-pos-bridge"),
  BRIDGE_JWKS_URL: z.string().trim().transform((value) => value || undefined).pipe(z.url().optional()),
  MAX_REQUEST_BYTES: integerFromEnv(32_768).pipe(z.number().min(1_024).max(131_072)),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  LOG_DIR: z.string().trim().min(1).default("logs"),
});

export interface BridgeConfig {
  projectRoot: string;
  port: number;
  allowedOrigin: string;
  printerName?: string;
  printerProfile: "s_pos_sp_240_u";
  drawerPin: 0 | 1;
  drawerPulseMs: number;
  drawerCooldownMs: number;
  authMode: "development" | "jwks";
  devSecret?: string;
  issuer: string;
  audience: string;
  jwksUrl?: string;
  maxRequestBytes: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  logDirectory: string;
}

export function loadConfig(): BridgeConfig {
  const parsed = environmentSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid bridge configuration: ${parsed.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join("; ")}`);
  }

  const source = parsed.data;
  const minimumCooldownMs = Math.ceil(source.DRAWER_PULSE_MS / 0.1);
  if (source.DRAWER_COOLDOWN_MS < minimumCooldownMs) {
    throw new Error(
      `DRAWER_COOLDOWN_MS must be at least ${minimumCooldownMs} ms for a ${source.DRAWER_PULSE_MS} ms pulse (10% duty limit).`,
    );
  }
  if (source.AUTH_MODE === "development" && !source.BRIDGE_DEV_SECRET) {
    throw new Error("BRIDGE_DEV_SECRET is required when AUTH_MODE=development.");
  }
  if (source.AUTH_MODE === "jwks" && !source.BRIDGE_JWKS_URL) {
    throw new Error("BRIDGE_JWKS_URL is required when AUTH_MODE=jwks.");
  }

  return {
    projectRoot,
    port: source.PORT,
    allowedOrigin: source.ALLOWED_ORIGIN,
    printerName: source.PRINTER_NAME || undefined,
    printerProfile: source.PRINTER_PROFILE,
    drawerPin: source.DRAWER_PIN,
    drawerPulseMs: source.DRAWER_PULSE_MS,
    drawerCooldownMs: source.DRAWER_COOLDOWN_MS,
    authMode: source.AUTH_MODE,
    devSecret: source.BRIDGE_DEV_SECRET,
    issuer: source.BRIDGE_ISSUER,
    audience: source.BRIDGE_AUDIENCE,
    jwksUrl: source.BRIDGE_JWKS_URL,
    maxRequestBytes: source.MAX_REQUEST_BYTES,
    logLevel: source.LOG_LEVEL,
    logDirectory: path.resolve(projectRoot, source.LOG_DIR),
  };
}
