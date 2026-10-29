import assert from "node:assert/strict";
import test from "node:test";
import { readFile,writeFile } from "node:fs/promises";
import { randomUUID,randomBytes,createDecipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fixture,pin } from "./offline-fixture.js";
import { OfflineJournal } from "../src/offline/journal.js";
import { OfflineHardware } from "../src/offline/hardware.js";
import { hash } from "../src/offline/contract.js";
import type { PosPrinter } from "../src/printer.js";
const mock=(calls:string[],failDrawer=false,failReceipt=false)=>({
 getStatus:async()=>({configured:true,found:true,state:"available"}),cut:async()=>{},
 openDrawer:async()=>{calls.push("drawer");if(failDrawer)throw Error("spool response lost");},
 printReceipt:async()=>{calls.push("receipt");if(failReceipt)throw Error("paper unavailable");}
}) as PosPrinter;
test("atomic sale, outbox, sequence, stock and hardware; duplicates have no extra effect",async()=>{
 const f=await fixture();try{
  const input=f.input();f.journal.prepare(f.grant,input);const r=f.journal.commit(f.grant,input);
  assert.equal(r.sale.envelope.sequence,1);assert.equal(r.sale.envelope.changeGiven,3000);
  assert.equal(f.journal.pendingCount(),1);assert.equal(f.journal.catalog(f.grant).items[0]!.available,2);
  assert.equal(f.journal.hardware(input.transactionId).length,2);assert.equal(f.journal.draft(f.grant),null);
  assert.ok(f.authority.verify(r.sale.envelope,r.sale.signature));assert.equal(f.journal.commit(f.grant,input).duplicate,true);
  assert.equal(f.journal.pendingCount(),1);
 }finally{await f.cleanup();}
});
test("failure after stock mutation rolls back all effects and sequence",async()=>{
 const f=await fixture();try{
  const input=f.input();f.journal.prepare(f.grant,input);const db=new DatabaseSync(f.filename);
  db.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
  assert.throws(()=>f.journal.commit(f.grant,input),/injected/);assert.equal(f.journal.pendingCount(),0);
  assert.equal(f.journal.catalog(f.grant).items[0]!.available,3);assert.equal(f.journal.history(f.grant).length,0);
  db.exec("DROP TRIGGER inject_failure");db.close();assert.equal(f.journal.commit(f.grant,input).sale.envelope.sequence,1);
 }finally{await f.cleanup();}
});
test("restart/lost response preserves original immutable sale; changed identity content rejected",async()=>{
 const f=await fixture();try{
  const input=f.input();f.journal.prepare(f.grant,input);const original=f.journal.commit(f.grant,input);
  f.reopen();const restored=f.journal.commit(f.grant,input);assert.equal(restored.duplicate,true);assert.deepEqual(restored.sale,original.sale);
  assert.throws(()=>f.journal.commit(f.grant,{...input,amountReceived:6000}),/different content/);
  const db=new DatabaseSync(f.filename);assert.throws(()=>db.prepare("UPDATE sales SET signature='bad'").run(),/immutable_sale/);
  assert.throws(()=>db.prepare("DELETE FROM sales").run(),/immutable_sale/);db.close();
 }finally{await f.cleanup();}
});
test("crashed SQLite process rolls back unfinished writes; committed cash survives",async()=>{
 const f=await fixture();try{
  const input=f.input();f.journal.prepare(f.grant,input);f.journal.commit(f.grant,input);
  const script="const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('BEGIN IMMEDIATE; UPDATE budgets SET remaining=0;');process.exit(17);";
  const child=spawnSync(process.execPath,["-e",script,f.filename],{windowsHide:true,encoding:"utf8"});assert.equal(child.status,17,child.stderr);
  f.reopen();assert.equal(f.journal.catalog(f.grant).items[0]!.available,2);assert.equal(f.journal.pendingCount(),1);
 }finally{await f.cleanup();}
});
test("two journal clients deduplicate one transaction and cannot overspend allocation",async()=>{
 const f=await fixture(1);let second:OfflineJournal|undefined;try{
  second=new OfflineJournal(f.filename,f.authority,()=>f.clock.now);
  const input=f.input();f.journal.prepare(f.grant,input);
  const results=await Promise.all([Promise.resolve().then(()=>f.journal.commit(f.grant,input)),Promise.resolve().then(()=>second!.commit(f.grant,input))]);
  assert.equal(results.filter(r=>!r.duplicate).length,1);const next=f.input();f.journal.prepare(f.grant,next);
  assert.throws(()=>second!.commit(f.grant,next),/exhausted/);assert.equal(f.journal.pendingCount(),1);
 }finally{second?.close();await f.cleanup();}
});
test("other tab cannot replace prepared sale; restart preserves preparation",async()=>{
 const f=await fixture();try{
  const input=f.input();f.journal.prepare(f.grant,input);assert.throws(()=>f.journal.prepare(f.grant,f.input()),/existing local request/);
  f.reopen();assert.equal(f.journal.draft(f.grant)!.transactionId,input.transactionId);
  f.journal.cancel(f.grant,input.transactionId);assert.equal(f.journal.draft(f.grant),null);
 }finally{await f.cleanup();}
});
test("pricing, catalog version, duplicate lines and stock limits fail closed",async()=>{
 const f=await fixture(1);try{
  let input={...f.input(),expectedTotal:1};f.journal.prepare(f.grant,input);assert.throws(()=>f.journal.commit(f.grant,input),/prices/);
  f.journal.cancel(f.grant,input.transactionId);input={...f.input(),catalogVersion:randomUUID()};
  f.journal.prepare(f.grant,input);assert.throws(()=>f.journal.commit(f.grant,input),/catalog/);f.journal.cancel(f.grant,input.transactionId);
  assert.throws(()=>f.journal.prepare(f.grant,{...f.input(),items:[{menuItemId:1,quantity:1},{menuItemId:1,quantity:1}]}),/duplicate/);
  const excess=f.input(2);f.journal.prepare(f.grant,excess);assert.throws(()=>f.journal.commit(f.grant,excess),/exhausted/);
  assert.equal(f.journal.pendingCount(),0);
 }finally{await f.cleanup();}
});
test("offline grant signature, terminal, epoch, expiry and session authorization",async()=>{
 const f=await fixture();try{
  const session=f.journal.login(f.grant.cashierId,pin);assert.equal(f.journal.session(session).cashierId,f.grant.cashierId);
  for(const change of [{terminalId:randomUUID()},{epoch:randomUUID()},{terminalKey:"x".repeat(43)}])
   await assert.rejects(f.journal.install(await f.token({...f.grant,grantId:randomUUID(),...change}),pin),/terminal/i);
  await assert.rejects(f.journal.install(f.signed,pin),/already installed/);
  await assert.rejects(f.journal.install(f.signed.slice(0,-8)+"tampered",pin));assert.throws(()=>f.journal.session("forged"),/Sign in/);
  f.clock.now+=61*60*1000;assert.throws(()=>f.journal.login(f.grant.cashierId,pin),/authorization/i);assert.throws(()=>f.journal.session(session),/Sign in/);
 }finally{await f.cleanup();}
});
test("PIN limits persist after restart; grant renewal cannot replenish inventory",async()=>{
 const f=await fixture(1);try{
  for(let i=0;i<5;i++)assert.throws(()=>f.journal.login(f.grant.cashierId,"00000000"));
  f.reopen();assert.throws(()=>f.journal.login(f.grant.cashierId,pin),/Wait/);
  const input=f.input();f.journal.prepare(f.grant,input);f.journal.commit(f.grant,input);
  const renewed={...f.grant,grantId:randomUUID()};await f.journal.install(await f.token(renewed),pin);
  assert.equal(f.journal.catalog(renewed).items[0]!.available,0);
  await assert.rejects(f.journal.install(await f.token({...renewed,grantId:randomUUID(),budgets:[{resourceId:1,quantity:99}]}),pin),/replaced/);
 }finally{await f.cleanup();}
});
test("clock rollback and allocation replacement are blocked",async()=>{
 const f=await fixture();try{
  const input=f.input();f.journal.prepare(f.grant,input);f.clock.now-=60_000;assert.throws(()=>f.journal.commit(f.grant,input),/time/);
  f.clock.now+=60_000;await assert.rejects(f.journal.install(await f.token({...f.grant,grantId:randomUUID(),allocationId:randomUUID()}),pin),/Reconcile/);
 }finally{await f.cleanup();}
});
test("drawer-first dispatch and receipt-only reprints are independent of failures",async()=>{
 for(const [failDrawer,failReceipt]of [[true,false],[false,true]]){
  const f=await fixture(),calls:string[]=[];try{
   const input=f.input();f.journal.prepare(f.grant,input);f.journal.commit(f.grant,input);
   const h=new OfflineHardware(f.journal,mock(calls,failDrawer,failReceipt));await h.initial(f.grant,input.transactionId);
   assert.deepEqual(calls,["drawer","receipt"]);await h.initial(f.grant,input.transactionId);assert.equal(calls.length,2);
   await h.reprint(f.grant,input.transactionId,randomUUID());assert.deepEqual(calls,["drawer","receipt","receipt"]);
   assert.equal(f.journal.pendingCount(),1);assert.throws(()=>f.journal.cancel(f.grant,input.transactionId),/Committed cash/);
  }finally{await f.cleanup();}
 }
});
test("pending hardware crash is uncertain and never replays drawer",async()=>{
 const f=await fixture(),calls:string[]=[];try{
  const input=f.input();f.journal.prepare(f.grant,input);f.journal.commit(f.grant,input);
  const id="offline:"+input.transactionId+":drawer:original";assert.equal(f.journal.claim(id,"drawer"),true);
  f.reopen();f.journal.recoverHardware();assert.equal(f.journal.claim(id,"drawer"),false);
  await new OfflineHardware(f.journal,mock(calls)).reprint(f.grant,input.transactionId,randomUUID());assert.deepEqual(calls,["receipt"]);
 }finally{await f.cleanup();}
});
test("durable drawer cooldown survives process restart",async()=>{
 const f=await fixture();try{
  const input=f.input();f.journal.prepare(f.grant,input);f.journal.commit(f.grant,input);
  assert.equal(f.journal.claim("offline:"+input.transactionId+":drawer:original","drawer"),true);
  f.reopen();f.journal.recoverHardware();const next=f.input();f.journal.prepare(f.grant,next);f.journal.commit(f.grant,next);
  assert.equal(f.journal.claim("offline:"+next.transactionId+":drawer:original","drawer"),false);
 }finally{await f.cleanup();}
});
test("encrypted backup round-trip restores pending cash and rejects wrong key",async()=>{
 const f=await fixture();try{
  const input=f.input();f.journal.prepare(f.grant,input);f.journal.commit(f.grant,input);
  const destination=path.join(f.directory,"backup.enc"),key=randomBytes(32),result=f.journal.backup(destination,key),bytes=await readFile(destination);
  assert.equal(result.terminalId,f.grant.terminalId);assert.equal(bytes.subarray(0,6).toString(),"SHPOS1");assert.equal(bytes.includes(Buffer.from("Test water")),false);
  function decrypt(k:Buffer){const d=createDecipheriv("aes-256-gcm",k,bytes.subarray(6,18));d.setAAD(Buffer.from("smokehouse-offline-backup-v1"));d.setAuthTag(bytes.subarray(18,34));return Buffer.concat([d.update(bytes.subarray(34)),d.final()]);}
  assert.throws(()=>decrypt(randomBytes(32)));
  const copy=path.join(f.directory,"restore.sqlite");await writeFile(copy,decrypt(key));
  const restored=new OfflineJournal(copy,f.authority,()=>f.clock.now);assert.equal(restored.pendingCount(),1);
  assert.equal(hash(restored.pending()[0]!.envelope),hash(f.journal.pending()[0]!.envelope));restored.close();
  assert.throws(()=>f.journal.backup(destination,key),/fresh/);
 }finally{await f.cleanup();}
});
test("corrupt SQLite and missing journal with marker fail closed",async()=>{
 const f=await fixture();try{
  const filename=path.join(f.directory,"broken.sqlite");await writeFile(filename,"not a database");assert.throws(()=>new OfflineJournal(filename,f.authority));
  const missing=path.join(f.directory,"missing.sqlite");await writeFile(missing+".identity","exists");assert.throws(()=>new OfflineJournal(missing,f.authority),/missing/);
 }finally{await f.cleanup();}
});

test("terminal private-key proof is fresh and uses a separate enrollment audience",async()=>{
 const f=await fixture();try{
  const nonce=randomUUID(),proof=await f.authority.enrollmentProof(nonce);
  const {jwtVerify,importJWK}=await import("jose");
  const verified=await jwtVerify(proof,await importJWK(f.authority.publicJwk,"EdDSA"),{
   audience:"smokehouse-offline-enrollment-v1",issuer:f.grant.terminalId
  });
  assert.equal(verified.payload.nonce,nonce);assert.equal(verified.payload.epoch,f.grant.epoch);
  assert.ok(verified.payload.exp!-verified.payload.iat!<=60);
  await assert.rejects(f.authority.verifyGrant(proof,f.clock.now));
 }finally{await f.cleanup();}
});
test("grant metadata and financial record corruption fail integrity verification",async()=>{
 const f=await fixture();try{
  const input=f.input();f.journal.prepare(f.grant,input);f.journal.commit(f.grant,input);
  const db=new DatabaseSync(f.filename);
  db.exec("DROP TRIGGER immutable_grant_update; UPDATE grants SET pin_hash='"+ "00".repeat(32) +"';");
  assert.throws(()=>f.journal.login(f.grant.cashierId,pin),/integrity/);
  db.exec("DROP TRIGGER immutable_sale_update; UPDATE sales SET signature='corrupt';");db.close();
  assert.throws(()=>f.journal.pending(),/verification/);
 }finally{await f.cleanup();}
});
test("backup inspection validates a fresh staging copy without activating it",async()=>{
 const f=await fixture();try{
  const {inspectBackup}=await import("../src/offline/backup.js");
  const input=f.input();f.journal.prepare(f.grant,input);f.journal.commit(f.grant,input);
  const destination=path.join(f.directory,"inspect.enc"),staging=path.join(f.directory,"staging.sqlite"),key=randomBytes(32);
  f.journal.backup(destination,key);const result=inspectBackup(destination,key,staging);
  assert.equal(result.pending,1);assert.equal(result.sequence,1);
  await assert.rejects(readFile(staging));
  assert.throws(()=>inspectBackup(destination,randomBytes(32),staging));
  assert.equal(f.journal.pendingCount(),1);
 }finally{await f.cleanup();}
});
