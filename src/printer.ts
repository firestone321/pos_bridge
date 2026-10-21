import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type pino from "pino";
import type { BridgeConfig } from "./config.js";
import { escpos } from "./escpos.js";
import { BridgeError } from "./errors.js";
import { buildReceipt } from "./receipt.js";
import type { PrinterStatus, Receipt } from "./types.js";

const execFileAsync = promisify(execFile);
const powerShell = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "powershell.exe";

interface WindowsPrinterProbe {
  found: boolean;
  name?: string;
  workOffline?: boolean;
  printerStatus?: number;
  detectedErrorState?: number;
  statusText?: string;
}

export type HardwareContext = { actionId: string };

export interface PosPrinter {
  getStatus(): Promise<PrinterStatus>;
  printReceipt(receipt: Receipt, context?: HardwareContext): Promise<void>;
  cut(): Promise<void>;
  openDrawer(context?: HardwareContext): Promise<void>;
}

async function runPowerShell(script: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(powerShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });
  return stdout.trim();
}

export async function listWindowsPrinters(projectRoot: string): Promise<Array<{ name: string; status: string; workOffline: boolean }>> {
  const script = path.join(projectRoot, "scripts", "list-printers.ps1");
  const output = await runPowerShell(script, []);
  return JSON.parse(output) as Array<{ name: string; status: string; workOffline: boolean }>;
}

export class WindowsRawPosPrinter implements PosPrinter {
  private tail: Promise<void> = Promise.resolve();
  private lastDrawerPulseAt = 0;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: pino.Logger,
  ) {}

  async getStatus(): Promise<PrinterStatus> {
    if (!this.config.printerName) {
      return { configured: false, found: false, state: "not_configured", detail: "PRINTER_NAME is not configured." };
    }
    try {
      const output = await runPowerShell(path.join(this.config.projectRoot, "scripts", "printer-status.ps1"), ["-PrinterName", this.config.printerName]);
      const probe = JSON.parse(output) as WindowsPrinterProbe;
      if (!probe.found) {
        return { configured: true, found: false, state: "unavailable", printerName: this.config.printerName, detail: "Configured printer was not found in Windows." };
      }
      const unavailable = probe.workOffline || (probe.printerStatus !== undefined && [1, 2, 7].includes(probe.printerStatus));
      return {
        configured: true,
        found: true,
        state: unavailable ? "unavailable" : "available",
        printerName: probe.name ?? this.config.printerName,
        detail: probe.statusText,
      };
    } catch (error) {
      this.logger.warn({ err: error, printerName: this.config.printerName }, "Printer status probe failed");
      return { configured: true, found: false, state: "error", printerName: this.config.printerName, detail: "Unable to query the Windows printer subsystem." };
    }
  }

  async printReceipt(receipt: Receipt, context?: HardwareContext): Promise<void> {
    await this.enqueue(async () => {
      await this.sendRaw(buildReceipt(receipt), `Smokehouse receipt ${receipt.saleId}`, context);
    }, context);
  }

  async cut(): Promise<void> {
    await this.enqueue(async () => this.sendRaw(Buffer.concat([escpos.initialize(), escpos.lineFeed(4), escpos.fullCut()]), "Smokehouse cutter test"));
  }

  async openDrawer(context?: HardwareContext): Promise<void> {
    await this.enqueue(async () => {
      const remaining = this.config.drawerCooldownMs - (Date.now() - this.lastDrawerPulseAt);
      if (remaining > 0) {
        throw new BridgeError("drawer_cooldown", `Drawer is cooling down; retry after ${remaining} ms.`, 429, { retryAfterMs: remaining });
      }
      try {
        await this.sendRaw(
          Buffer.concat([escpos.initialize(), escpos.drawerPulse(this.config.drawerPin, this.config.drawerPulseMs)]),
          "Smokehouse authorized drawer open", context,
        );
        this.lastDrawerPulseAt = Date.now();
      } catch (error) {
        if (error instanceof BridgeError) throw new BridgeError("drawer_failed", error.message, error.status);
        throw error;
      }
    }, context);
  }

  async sendRawForHardwareTest(bytes: Buffer, documentName: string): Promise<void> {
    await this.enqueue(async () => this.sendRaw(bytes, documentName));
  }

  private async enqueue(operation: () => Promise<void>, context?: HardwareContext): Promise<void> {
    const queuedAt = performance.now();
    const work = async () => {
      if (context) this.logger.info({ event: "pos_hardware_timing", actionId: context.actionId, stage: "queue_wait", elapsedMs: performance.now()-queuedAt });
      await operation();
    };
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async sendRaw(bytes: Buffer, documentName: string, context?: HardwareContext): Promise<void> {
    if (!this.config.printerName) {
      throw new BridgeError("printer_not_configured", "PRINTER_NAME is not configured.", 503);
    }
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "smokehouse-pos-bridge-"));
    const bytesPath = path.join(temporaryDirectory, `${randomUUID()}.bin`);
    try {
      await fs.writeFile(bytesPath, bytes, { flag: "wx" });
      const processStart = performance.now();
      const output = await runPowerShell(path.join(this.config.projectRoot, "scripts", "send-raw-printer.ps1"), [
        "-PrinterName", this.config.printerName,
        "-BytesPath", bytesPath,
        "-DocumentName", documentName,
      ]);
      if (context) {
        const result = JSON.parse(output) as { jobId?: number; spoolMs?: number };
        this.logger.info({ event: "pos_hardware_timing", actionId: context.actionId, stage: "windows_submission", processMs: performance.now()-processStart, spoolMs: result.spoolMs, windowsJobId: result.jobId });
      }
    } catch (error) {
      this.logger.error({ err: error, printerName: this.config.printerName, documentName }, "RAW printer job failed");
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("print_failed", "Windows could not submit the RAW printer job.", 503);
    } finally {
      await fs.rm(temporaryDirectory, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}
