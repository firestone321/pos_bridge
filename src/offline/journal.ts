import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync, chmodSync, openSync, closeSync, fsyncSync } from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync, timingSafeEqual, createCipheriv, createHash } from "node:crypto";
import { schema } from "./schema.js";
import { OfflineError, hash, canonical, normalizeInput, validateGrant, kampalaDate, type Grant, type CashInput } from "./contract.js";
import type { OfflineAuthority } from "./security.js";
import type { Receipt } from "../types.js";

export type Envelope = {
  version: 1; transactionId: string; terminalId: string; epoch: string; sequence: number;
  cashierId: string; grantId: string; authorization: string; allocationId: string; catalogVersion: string;
  occurredAt: string; serviceDate: string; amountReceived: number; changeGiven: number;
  items: Array<{ menuItemId: number; name: string; quantity: number; unitPrice: number; total: number;
    requirements: Array<{resourceId:number;quantity:number}> }>;
  receipt: Receipt; inputHash: string;
};
export type Sale = { envelope: Envelope; signature: string };
type SaleRow = { envelope:string; signature:string; input_hash:string; cashier_id:string };
export class OfflineJournal {
  private db: DatabaseSync;
  private failed = false;
  constructor(readonly filename: string, private authority: OfflineAuthority, private now = Date.now, private drawerCooldownMs=1000) {
    mkdirSync(path.dirname(filename), {recursive:true, mode:0o700});
    const marker = filename + ".identity";
    if (!existsSync(filename) && existsSync(marker)) throw Error("Journal missing: restore and fence the terminal; never recreate it.");
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      const check = this.db.prepare("PRAGMA quick_check").get() as {quick_check:string};
      if (check.quick_check !== "ok") throw Error("Journal integrity check failed");
      const version = Number((this.db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version);
      if (version === 0) {
        if (existsSync(marker) || this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length)
          throw Error("Unexpected journal schema; recovery required.");
        this.atomic(() => {
          this.db.exec(schema);
          for (const [key,value] of Object.entries({ terminalId:authority.terminalId, epoch:authority.epoch,
            sequence:"0", lastClock:"0", publicKey:canonical(authority.publicJwk) }))
            this.db.prepare("INSERT INTO meta VALUES(?,?)").run(key,value);
        });
      } else if (version !== 1) throw Error("Unsupported journal version; do not downgrade.");
      for (const [key,value] of Object.entries({terminalId:authority.terminalId,epoch:authority.epoch,publicKey:canonical(authority.publicJwk)}))
        if (this.meta(key) !== value) throw Error("Journal terminal identity mismatch");
      if (!existsSync(marker)) writeFileSync(marker, canonical({terminalId:authority.terminalId,epoch:authority.epoch}), {flag:"wx",mode:0o600});
      chmodSync(filename,0o600);
      // Validate immutable financial records on startup. No silent empty-journal fallback.
      for (const row of this.db.prepare("SELECT * FROM sales").all()) this.decode(row as unknown as SaleRow);
    } catch(error) { this.db.close(); throw error; }
  }
  private meta(key:string) { return (this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as {value:string}).value; }
  private healthy() { if(this.failed) throw new OfflineError("journal_unhealthy","Stop: the journal requires supervised recovery.",503); }
  private atomic<T>(work:()=>T):T {
    this.healthy(); this.db.exec("BEGIN IMMEDIATE");
    try { const value=work(); this.db.exec("COMMIT"); return value; }
    catch(error) { try {this.db.exec("ROLLBACK");} catch {this.failed=true;} throw error; }
  }
  private clock() {
    const now=this.now();
    if (now+30_000 < Number(this.meta("lastClock"))) throw new OfflineError("clock_rollback","Correct terminal time before further cash sales.",403);
    this.db.prepare("UPDATE meta SET value=? WHERE key='lastClock'").run(String(Math.max(now,Number(this.meta("lastClock")))));
    return now;
  }
  async install(token:string, pin:string) {
    const grant=await this.authority.verifyGrant(token,this.now());
    if (!/^\d{8,12}$/.test(pin)) throw new OfflineError("invalid_pin","Use an 8–12 digit offline PIN.",422);
    if (grant.terminalId!==this.authority.terminalId || grant.epoch!==this.authority.epoch)
      throw new OfflineError("terminal_mismatch","Wrong terminal.",403);
    this.atomic(()=>{
      this.clock();
      if (this.db.prepare("SELECT id FROM grants WHERE id=?").get(grant.grantId))
        throw new OfflineError("grant_replayed","Grant already installed. Use your PIN; a fresh online grant is required to reset it.",403);
      const fingerprint=hash({catalogVersion:grant.catalogVersion,serviceDate:grant.serviceDate,items:grant.items,budgets:grant.budgets});
      const prior=this.db.prepare("SELECT fingerprint FROM allocations WHERE id=?").get(grant.allocationId) as {fingerprint:string}|undefined;
      if(prior && prior.fingerprint!==fingerprint) throw new OfflineError("allocation_changed","Allocation cannot be replaced or replenished by replay.");
      if(!prior) {
        // Do not stack allocations until Phase 3C has a terminal-wide handover protocol.
        if(this.db.prepare("SELECT id FROM allocations").get()) throw new OfflineError("allocation_handover_required","Reconcile this terminal before changing allocation.");
        this.db.prepare("INSERT INTO allocations VALUES(?,?)").run(grant.allocationId,fingerprint);
        for(const b of grant.budgets) this.db.prepare("INSERT INTO budgets VALUES(?,?,?)").run(grant.allocationId,b.resourceId,b.quantity);
      }
      const salt=randomBytes(16).toString("hex"), digest=scryptSync(pin,salt,32).toString("hex");
      const body=canonical(grant);
      const signature=this.authority.sign({body,token,salt,pinHash:digest});
      this.db.prepare("INSERT INTO grants VALUES(?,?,?,?,?,?,?)").run(grant.grantId,grant.cashierId,body,token,salt,digest,signature);
      this.db.prepare("DELETE FROM sessions WHERE grant_id IN (SELECT id FROM grants WHERE cashier_id=?)").run(grant.cashierId);
    });
  }
  login(cashierId:string,pin:string) {
    this.healthy();
    if(!/^\d{8,12}$/.test(pin)) throw new OfflineError("invalid_login","Invalid offline sign-in.",403);
    const rows=this.db.prepare("SELECT * FROM grants WHERE cashier_id=? ORDER BY rowid DESC").all(cashierId) as unknown as Array<{id:string;body:string;token:string;salt:string;pin_hash:string;record_signature:string}>;
    const row=rows[0];
    this.atomic(()=>{
      const now=this.clock();
      const limit=this.db.prepare("SELECT attempts,started_at FROM login_limits WHERE slot='terminal'").get() as {attempts:number;started_at:number}|undefined;
      if(limit && now-limit.started_at<15*60*1000 && limit.attempts>=5)
        throw new OfflineError("login_rate_limit","Wait before trying another offline PIN.",429);
      this.db.prepare("INSERT INTO login_limits VALUES('terminal',1,?) ON CONFLICT(slot) DO UPDATE SET attempts=CASE WHEN ?-started_at>=900000 THEN 1 ELSE attempts+1 END,started_at=CASE WHEN ?-started_at>=900000 THEN ? ELSE started_at END").run(now,now,now,now);
    });
    if(row && !this.authority.verify({body:row.body,token:row.token,salt:row.salt,pinHash:row.pin_hash},row.record_signature))
      throw new OfflineError("grant_corrupt","Offline authorization failed integrity verification.",503);
    if(!row || !timingSafeEqual(scryptSync(pin,row.salt,32),Buffer.from(row.pin_hash,"hex")))
      throw new OfflineError("invalid_login","Invalid offline sign-in.",403);
    const grant=validateGrant(JSON.parse(row.body),this.now());
    const token=randomBytes(32).toString("base64url");
    this.atomic(()=> {
      this.clock();
      this.db.prepare("DELETE FROM login_limits").run();
      this.db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(this.now());
      this.db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(hash(token),row.id,Math.min(grant.expiresAt,this.now()+15*60*1000));
    });
    return token;
  }
  session(token:string):Grant {
    this.healthy();
    const row=this.db.prepare("SELECT g.*,s.expires_at FROM sessions s JOIN grants g ON g.id=s.grant_id WHERE token_hash=?").get(hash(token)) as {body:string;token:string;salt:string;pin_hash:string;record_signature:string;expires_at:number}|undefined;
    if(!row || row.expires_at<=this.now()) throw new OfflineError("session_expired","Sign in to the offline terminal again.",401);
    if(!this.authority.verify({body:row.body,token:row.token,salt:row.salt,pinHash:row.pin_hash},row.record_signature))
      throw new OfflineError("grant_corrupt","Offline authorization failed integrity verification.",503);
    const grant=validateGrant(JSON.parse(row.body),this.now());
    if(this.now()+30_000<Number(this.meta("lastClock"))) throw new OfflineError("clock_rollback","Terminal clock moved backwards.",403);
    return grant;
  }
  logout(token:string) { this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token)); }
  catalog(grant:Grant) {
    const remaining=this.db.prepare("SELECT resource_id,remaining FROM budgets WHERE allocation_id=?").all(grant.allocationId) as Array<{resource_id:number;remaining:number}>;
    return { catalogVersion:grant.catalogVersion, expiresAt:grant.expiresAt, cashierId:grant.cashierId,
      items:grant.items.map(i=>({menuItemId:i.menuItemId,name:i.name,unitPrice:i.unitPrice,
        available:Math.min(...i.requirements.map(r=>Math.floor((remaining.find(b=>b.resource_id===r.resourceId)?.remaining||0)/r.quantity))) })) };
  }
  prepare(grant:Grant,value:unknown) {
    const input=normalizeInput(value);
    return this.atomic(()=>{
      this.clock();
      const existing=this.db.prepare("SELECT transaction_id,input FROM drafts WHERE cashier_id=?").get(grant.cashierId) as {transaction_id:string;input:string}|undefined;
      if(existing && existing.input!==canonical(input)) throw new OfflineError("pending_sale","Recover the existing local request before preparing another.",409);
      if(!existing) this.db.prepare("INSERT INTO drafts VALUES(?,?,?)").run(grant.cashierId,input.transactionId,canonical(input));
      return input;
    });
  }
  cancel(grant:Grant,id:string) {
    // Only a definitely uncommitted preparation may be cancelled.
    this.atomic(()=>{
      if(this.db.prepare("SELECT id FROM sales WHERE id=?").get(id)) throw new OfflineError("already_committed","Committed cash cannot be cancelled here.");
      this.db.prepare("DELETE FROM drafts WHERE cashier_id=? AND transaction_id=?").run(grant.cashierId,id);
    });
  }
  draft(grant:Grant):CashInput|null {
    const row=this.db.prepare("SELECT input FROM drafts WHERE cashier_id=?").get(grant.cashierId) as {input:string}|undefined;
    return row?JSON.parse(row.input):null;
  }
  commit(grant:Grant,value:unknown):{sale:Sale;duplicate:boolean} {
    const input=normalizeInput(value), inputHash=hash(input);
    return this.atomic(()=>{
      const prior=this.db.prepare("SELECT * FROM sales WHERE id=?").get(input.transactionId) as unknown as SaleRow|undefined;
      if(prior) {
        if(prior.cashier_id!==grant.cashierId || prior.input_hash!==inputHash) throw new OfflineError("identity_conflict","Transaction identity was reused with different content.");
        return {sale:this.decode(prior),duplicate:true};
      }
      const now=this.clock(); validateGrant(grant,now);
      if(kampalaDate(now)!==grant.serviceDate) throw new OfflineError("service_date_expired","Obtain a new service-day authorization.",403);
      if(input.catalogVersion!==grant.catalogVersion) throw new OfflineError("stale_catalog","Reload the approved local catalog.");
      const draft=this.draft(grant);
      if(!draft || canonical(draft)!==canonical(input)) throw new OfflineError("preparation_required","Prepare and preserve the original request first.");
      const items=input.items.map(line=>{
        const item=grant.items.find(i=>i.menuItemId===line.menuItemId);
        if(!item) throw new OfflineError("item_unavailable","Item is not approved for offline sale.");
        return {...item,quantity:line.quantity,total:item.unitPrice*line.quantity};
      });
      const total=items.reduce((sum,i)=>sum+i.total,0);
      if(!Number.isSafeInteger(total)||total!==input.expectedTotal||input.amountReceived<total)
        throw new OfflineError("amount_mismatch","Approved prices and cash received must match the displayed sale.");
      const required=new Map<number,number>();
      for(const item of items) for(const r of item.requirements) required.set(r.resourceId,(required.get(r.resourceId)||0)+r.quantity*item.quantity);
      for(const [resourceId,quantity] of [...required].sort(([a],[b])=>a-b)) {
        const result=this.db.prepare("UPDATE budgets SET remaining=remaining-? WHERE allocation_id=? AND resource_id=? AND remaining>=?").run(quantity,grant.allocationId,resourceId,quantity);
        if(Number(result.changes)!==1) throw new OfflineError("allocation_exhausted","Reserved offline stock is exhausted.");
      }
      const sequence=Number(this.meta("sequence"))+1;
      if(!Number.isSafeInteger(sequence)) throw new OfflineError("sequence_exhausted","Terminal sequence requires supervised migration.");
      const reference="L-"+grant.terminalId.slice(0,8)+"-"+grant.epoch.slice(0,8)+"-"+sequence.toString().padStart(6,"0");
      const receipt:Receipt={saleId:reference,date:new Date(now).toISOString(),
        items:items.map(i=>({name:i.name,quantity:i.quantity,unitPrice:i.unitPrice,total:i.total})),
        subtotal:total,total,paymentMethod:"cash"};
      const token=(this.db.prepare("SELECT token FROM grants WHERE id=?").get(grant.grantId) as {token:string}).token;
      const envelope:Envelope={version:1,transactionId:input.transactionId,terminalId:grant.terminalId,epoch:grant.epoch,sequence,
        cashierId:grant.cashierId,grantId:grant.grantId,authorization:token,allocationId:grant.allocationId,
        catalogVersion:grant.catalogVersion,occurredAt:receipt.date,serviceDate:grant.serviceDate,
        amountReceived:input.amountReceived,changeGiven:input.amountReceived-total,items,receipt,inputHash};
      const signature=this.authority.sign(envelope);
      this.db.prepare("INSERT INTO sales VALUES(?,?,?,?,?,?,?)").run(input.transactionId,sequence,grant.cashierId,grant.grantId,inputHash,canonical(envelope),signature);
      this.db.prepare("INSERT INTO outbox(sale_id) VALUES(?)").run(input.transactionId);
      for(const kind of ["drawer","receipt"]) this.db.prepare("INSERT INTO hardware(id,sale_id,kind,state) VALUES(?,?,?,'ready')").run("offline:"+input.transactionId+":"+kind+":original",input.transactionId,kind);
      this.db.prepare("UPDATE meta SET value=? WHERE key='sequence'").run(String(sequence));
      this.db.prepare("DELETE FROM drafts WHERE cashier_id=?").run(grant.cashierId);
      return {sale:{envelope,signature},duplicate:false};
    });
  }
  private decode(row:SaleRow):Sale {
    const envelope=JSON.parse(row.envelope) as Envelope;
    if(!this.authority.verify(envelope,row.signature) || envelope.inputHash!==row.input_hash)
      {this.failed=true;throw new OfflineError("journal_corrupt","Financial record failed verification. Stop and recover.",503);}
    return {envelope,signature:row.signature};
  }
  sale(grant:Grant,id:string) {
    this.healthy(); const row=this.db.prepare("SELECT * FROM sales WHERE id=? AND cashier_id=?").get(id,grant.cashierId) as unknown as SaleRow|undefined;
    return row?this.decode(row):null;
  }
  history(grant:Grant) {
    this.healthy();
    return this.db.prepare("SELECT s.*,o.state AS sync_state FROM sales s JOIN outbox o ON o.sale_id=s.id WHERE cashier_id=? ORDER BY sequence DESC LIMIT 20")
      .all(grant.cashierId).map(row=>({...this.decode(row as unknown as SaleRow),syncState:row.sync_state,hardware:this.hardware(String(row.id))}));
  }
  pendingCount() { return Number((this.db.prepare("SELECT count(*) AS count FROM outbox WHERE state<>'acknowledged'").get() as {count:number}).count); }
  hardware(id:string) { this.healthy();return this.db.prepare("SELECT id,kind,state,detail FROM hardware WHERE sale_id=? ORDER BY rowid").all(id); }
  recoverHardware() { this.db.prepare("UPDATE hardware SET state='outcome_unknown' WHERE state='pending'").run(); }
  createReprint(grant:Grant,id:string,requestId:string) {
    if(!grant.permissions.includes("reprint")||!this.sale(grant,id)) throw new OfflineError("reprint_denied","Receipt access denied.",403);
    const actionId="offline:"+id+":receipt:"+requestId;
    this.db.prepare("INSERT OR IGNORE INTO hardware(id,sale_id,kind,state) VALUES(?,?,'receipt','ready')").run(actionId,id);
    return actionId;
  }
  claim(actionId:string,kind:"drawer"|"receipt"):boolean {
    return this.atomic(()=>{
      const row=this.db.prepare("SELECT state FROM hardware WHERE id=? AND kind=?").get(actionId,kind) as {state:string}|undefined;
      if(!row || row.state!=="ready") return false;
      const now=this.clock();
      if(kind==="drawer") {
        const last=this.db.prepare("SELECT max(claimed_at) AS last,count(*) AS count FROM hardware WHERE kind='drawer' AND claimed_at>?").get(now-60_000) as {last:number|null;count:number};
        if(last.count>=6 || (last.last!==null && now-last.last<this.drawerCooldownMs)) {
          this.db.prepare("UPDATE hardware SET state='rejected',detail='drawer_rate_limit' WHERE id=?").run(actionId); return false;
        }
      }
      this.db.prepare("UPDATE hardware SET state='pending',claimed_at=? WHERE id=? AND state='ready'").run(now,actionId);
      return true;
    });
  }
  finish(actionId:string,state:"submitted"|"outcome_unknown",detail?:string) {
    this.healthy();this.db.prepare("UPDATE hardware SET state=?,detail=? WHERE id=? AND state='pending'").run(state,detail||null,actionId);
  }
  // Phase 3B reads immutable signed envelopes, and must persist per-sale cloud acknowledgements.
  pending(limit=25) {
    this.healthy();
    return this.db.prepare("SELECT s.* FROM sales s JOIN outbox o ON s.id=o.sale_id WHERE o.state<>'acknowledged' ORDER BY sequence LIMIT ?").all(Math.max(1,Math.min(limit,100))).map(r=>this.decode(r as unknown as SaleRow));
  }
  backup(destination:string,key:Buffer) {
    this.healthy();
    if(key.length!==32 || existsSync(destination)) throw new OfflineError("backup_invalid","Use a fresh backup path and a 32-byte recovery key.");
    const temp=destination+".sqlite-"+randomBytes(8).toString("hex");
    try {
      this.db.prepare("VACUUM INTO ?").run(temp);chmodSync(temp,0o600);
      const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,iv);
      cipher.setAAD(Buffer.from("smokehouse-offline-backup-v1"));
      const encrypted=Buffer.concat([cipher.update(readFileSync(temp)),cipher.final()]);
      const bytes=Buffer.concat([Buffer.from("SHPOS1"),iv,cipher.getAuthTag(),encrypted]);
      writeFileSync(destination,bytes,{flag:"wx",mode:0o600});
      const handle=openSync(destination,"r+");try{fsyncSync(handle);}finally{closeSync(handle);}
      return {sha256:createHash("sha256").update(bytes).digest("hex"),terminalId:this.authority.terminalId,epoch:this.authority.epoch};
    } finally {if(existsSync(temp))unlinkSync(temp);}
  }
  close() {this.db.close();}
}
