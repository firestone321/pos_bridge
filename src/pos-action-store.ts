import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { BridgeError } from "./errors.js";
export type PosAction = { actionId: string; saleId: string; kind: "drawer" | "receipt"; receiptHash: string };
type Record = PosAction & { version: 1; state: "pending" | "submitted" | "rejected" | "outcome_unknown" };
/** Single bridge instance. Exclusive durable claim precedes any physical submission.
 * A pending record after a crash is UNCERTAIN and must never be executed again. */
export class PosActionStore {
  constructor(private readonly directory: string) {}
  private file(actionId: string) { return path.join(this.directory, createHash("sha256").update(actionId).digest("hex") + ".json"); }
  private async read(action: PosAction): Promise<Record | null> {
    try {
      const record = JSON.parse(await readFile(this.file(action.actionId), "utf8")) as Record;
      if (record.version !== 1 || record.actionId !== action.actionId || record.saleId !== action.saleId ||
        record.kind !== action.kind || record.receiptHash !== action.receiptHash ||
        !["pending", "submitted", "rejected", "outcome_unknown"].includes(record.state)) throw new Error("Invalid hardware action ledger");
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // Corruption, disk errors and identity collisions fail closed.
      throw new BridgeError("hardware_outcome_unknown", "Hardware action storage could not be verified. Staff review required.", 409);
    }
  }
  async status(action: PosAction): Promise<"not_requested" | "submitted" | "rejected" | "outcome_unknown"> {
    const record = await this.read(action);
    return !record ? "not_requested" : record.state === "submitted" ? "submitted" : record.state === "rejected" ? "rejected" : "outcome_unknown";
  }
  private async replace(record: Record) {
    const target = this.file(record.actionId);
    const temp = target + "." + randomUUID() + ".tmp";
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, target);
  }
  async execute(action: PosAction, submit: () => Promise<void>): Promise<{ status: "submitted"; duplicate: boolean }> {
    await mkdir(this.directory, { recursive: true });
    const prior = await this.status(action);
    if (prior === "submitted") return { status: "submitted", duplicate: true };
    if (prior === "rejected") throw new BridgeError("hardware_action_rejected", "The prior command was rejected before Windows submission. Staff review required; no automatic replay.", 409);
    if (prior !== "not_requested") throw new BridgeError("hardware_outcome_unknown", "An earlier submission may have executed. No replay is allowed.", 409);
    const record: Record = { ...action, version: 1, state: "pending" };
    try {
      const handle = await open(this.file(action.actionId), "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if (await this.status(action) === "submitted") return { status: "submitted", duplicate: true };
      }
      throw new BridgeError("hardware_outcome_unknown", "Unable to claim this hardware action safely. No replay is allowed.", 409);
    }
    try {
      await submit();
      await this.replace({ ...record, state: "submitted" });
      return { status: "submitted", duplicate: false };
    } catch (error) {
      // These checks occur before the OS boundary. Other spool failures are ambiguous.
      const rejected = error instanceof BridgeError && ["drawer_cooldown", "printer_not_configured"].includes(error.code);
      let persisted = false;
      try { await this.replace({ ...record, state: rejected ? "rejected" : "outcome_unknown" }); persisted = true; }
      catch { /* Existing pending claim still prevents replay. */ }
      if (rejected && persisted) throw error;
      throw new BridgeError("hardware_outcome_unknown", "Submission may have reached Windows. Staff review required; no automatic replay.", 409);
    }
  }
}
