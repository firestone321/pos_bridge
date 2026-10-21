import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type ReceiptJobState = "accepted" | "spooled" | "uncertain";

export type ReceiptJobRecord = {
  jobId: string;
  saleId: string;
  receiptFingerprint: string;
  state: ReceiptJobState;
  acceptedAt: string;
  updatedAt: string;
  failure?: string;
};

type PersistedStore = {
  version: 1;
  jobs: ReceiptJobRecord[];
};

/**
 * A tiny, process-local durable ledger. A job is recorded before spool
 * submission, deliberately preferring at-most-once receipt submission over a
 * retry that could produce a duplicate physical receipt after a crash.
 */
export class ReceiptJobStore {
  private loaded = false;
  private readonly jobs = new Map<string, ReceiptJobRecord>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async reserve(input: { jobId: string; saleId: string; receiptFingerprint: string }): Promise<{ record: ReceiptJobRecord; isNew: boolean }> {
    return this.serialise(async () => {
      await this.ensureLoaded();
      const existing = this.jobs.get(input.jobId);
      if (existing) {
        if (existing.saleId !== input.saleId || existing.receiptFingerprint !== input.receiptFingerprint) {
          throw new ReceiptJobCollisionError();
        }
        return { record: existing, isNew: false };
      }

      const now = new Date().toISOString();
      const record: ReceiptJobRecord = {
        jobId: input.jobId,
        saleId: input.saleId,
        receiptFingerprint: input.receiptFingerprint,
        state: "accepted",
        acceptedAt: now,
        updatedAt: now,
      };
      this.jobs.set(record.jobId, record);
      await this.persist();
      return { record, isNew: true };
    });
  }

  async markSpooled(jobId: string): Promise<ReceiptJobRecord> {
    return this.update(jobId, (record) => ({ ...record, state: "spooled", updatedAt: new Date().toISOString(), failure: undefined }));
  }

  async markUncertain(jobId: string, error: string): Promise<ReceiptJobRecord> {
    return this.update(jobId, (record) => ({ ...record, state: "uncertain", updatedAt: new Date().toISOString(), failure: error.slice(0, 500) }));
  }

  private async update(jobId: string, update: (record: ReceiptJobRecord) => ReceiptJobRecord): Promise<ReceiptJobRecord> {
    return this.serialise(async () => {
      await this.ensureLoaded();
      const existing = this.jobs.get(jobId);
      if (!existing) throw new Error("Receipt job record not found.");
      const record = update(existing);
      this.jobs.set(jobId, record);
      await this.persist();
      return record;
    });
  }

  private async serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(contents) as Partial<PersistedStore>;
      if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) throw new Error("invalid receipt-job ledger");
      for (const record of parsed.jobs) {
        if (record && typeof record.jobId === "string" && typeof record.saleId === "string" && typeof record.receiptFingerprint === "string") {
          this.jobs.set(record.jobId, record);
        }
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const payload: PersistedStore = { version: 1, jobs: [...this.jobs.values()] };
    await writeFile(temporaryPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}

export class ReceiptJobCollisionError extends Error {}
