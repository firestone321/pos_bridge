import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import type { BridgeConfig } from "./config.js";

export function createLogger(config: BridgeConfig): pino.Logger {
  fs.mkdirSync(config.logDirectory, { recursive: true });
  const fileDestination = pino.destination({
    dest: path.join(config.logDirectory, "bridge.log"),
    mkdir: true,
    sync: false,
  });
  return pino(
    {
      level: config.logLevel,
      base: { service: "smokehouse-pos-bridge", version: "0.2.0" },
      redact: ["req.headers.authorization", "authorization", "token", "secret"],
    },
    pino.multistream([{ stream: process.stdout }, { stream: fileDestination }]),
  );
}
