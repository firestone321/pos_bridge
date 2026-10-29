import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { SignJWT } from "jose";
import pino from "pino";
import { z } from "zod";
import { PosActionStore, type PosAction } from "../src/pos-action-store.js";
import { createPosActionsRouter } from "../src/pos-actions-router.js";
import { HardwareAuthorizer } from "../src/auth.js";
import { WindowsRawPosPrinter } from "../src/printer.js";
import type { BridgeConfig } from "../src/config.js";
import type { Receipt } from "../src/types.js";
import { receiptFingerprint } from "../src/receipt-fingerprint.js";
import { BridgeError } from "../src/errors.js";
const secret = new TextEncoder().encode("unit-test-only-not-a-deployment-key");
const logger = pino({ enabled: false });
const receipt: Receipt = { saleId: "123", date: "2026-10-18T10:00:00.000Z", items: [{name:"Test",quantity:1,unitPrice:100,total:100}], subtotal:100,total:100,paymentMethod:"cash" };
const action: PosAction = { actionId:"pos:1:drawer:original",saleId:receipt.saleId,kind:"drawer",receiptHash:receiptFingerprint(receipt) };
const config = { authMode:"development", devSecret:new TextDecoder().decode(secret), issuer:"test", audience:"test", drawerCooldownMs:1000,drawerPin:0,drawerPulseMs:80,printerName:"MOCK" } as BridgeConfig;
async function directory() { return mkdtemp(path.join(os.tmpdir(),"smokehouse-pos-action-test-")); }

test("durable drawer action survives restart and refreshed tokens cannot repeat it",async()=>{
  const dir=await directory(); let pulses=0;
  try {
    await new PosActionStore(dir).execute(action,async()=>{pulses++;});
    const repeated=await new PosActionStore(dir).execute(action,async()=>{pulses++;});
    assert.equal(repeated.duplicate,true); assert.equal(pulses,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test("uncertain spool outcome and pending crash claim never automatically replay",async()=>{
  const dir=await directory();let pulses=0;
  try {
    await assert.rejects(new PosActionStore(dir).execute(action,async()=>{pulses++;throw Error("response lost");}));
    await assert.rejects(new PosActionStore(dir).execute(action,async()=>{pulses++;}));
    assert.equal(await new PosActionStore(dir).status(action),"outcome_unknown");assert.equal(pulses,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("concurrent claims execute once and corruption fails closed",async()=>{
  const dir=await directory();let calls=0;let release!:()=>void;
  try {
    let entered!:()=>void; const started=new Promise<void>(r=>{entered=r;});
    const gate=new Promise<void>(r=>{release=r;});
    const first=new PosActionStore(dir).execute(action,async()=>{calls++;entered();await gate;});
    await started;
    await assert.rejects(new PosActionStore(dir).execute(action,async()=>{calls++;}));
    release();await first;assert.equal(calls,1);
    const file=(await readdir(dir)).find(p=>p.endsWith(".json"))!;
    await writeFile(path.join(dir,file),"broken");
    await assert.rejects(new PosActionStore(dir).execute(action,async()=>{calls++;}));
    assert.equal(calls,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("shared printer queue preserves order, recovers from rejection and retains cooldown",async(t)=>{
  t.mock.method(Date,"now",()=>10000);
  const printer=new WindowsRawPosPrinter(config,logger);
  const calls:string[]=[];
  // Replace only the OS boundary. No PowerShell or physical hardware is executed.
  (printer as unknown as {sendRaw:(bytes:Buffer,name:string)=>Promise<void>}).sendRaw=async(_bytes,name)=>{calls.push(name);};
  await Promise.all([printer.openDrawer(),printer.printReceipt(receipt)]);
  assert.match(calls[0]!,/drawer/);assert.match(calls[1]!,/receipt/);
  await assert.rejects(printer.openDrawer(),(e:unknown)=>e instanceof BridgeError && e.code==="drawer_cooldown");
  await printer.printReceipt(receipt);assert.equal(calls.length,3);
});

async function harness() {
  const dir=await directory();const calls:string[]=[];
  const app=express();app.use(express.json());
  const schema=z.custom<Receipt>((r)=>!!r && typeof r==="object" && "saleId" in r);
  const authorizer=new HardwareAuthorizer(config);
  const drawerLimit=rateLimit({windowMs:60_000,limit:6,legacyHeaders:false,standardHeaders:"draft-8"});
  app.use("/pos",createPosActionsRouter({authorizer,store:new PosActionStore(dir),logger,receiptSchema:schema,drawerLimit,
    requireOrigin:(req,_res,next)=>next(req.header("origin")==="https://pos.test"?undefined:new BridgeError("origin_rejected","Origin rejected.",403)),
    printer:{getStatus:async()=>({configured:true,found:true,state:"available"}),cut:async()=>{},openDrawer:async()=>{calls.push("drawer");},printReceipt:async()=>{calls.push("receipt");}}
  }));
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    res.status(error instanceof BridgeError?error.status:500).json({ok:false,error:{code:error instanceof BridgeError?error.code:"internal_error"}});
  });
  const server=app.listen(0,"127.0.0.1");
  await new Promise<void>(r=>server.once("listening",r));
  const address=server.address() as {port:number};
  async function token(kind:"drawer"|"receipt",id:string,expired=false) {
    return new SignJWT({action:kind==="drawer"?"open_drawer":"print_receipt",sale_id:receipt.saleId,pos_action_id:id,receipt_hash:receiptFingerprint(receipt)})
      .setProtectedHeader({alg:"HS256"}).setIssuer("test").setAudience("test").setJti(crypto.randomUUID()).setIssuedAt().setExpirationTime(expired?"0s":"60s").sign(secret);
  }
  async function send(endpoint:string,kind:"drawer"|"receipt",id:string,options:{expired?:boolean;origin?:string;tamper?:boolean}={}) {
    return fetch("http://127.0.0.1:"+address.port+"/pos/"+endpoint,{method:"POST",headers:{"content-type":"application/json",origin:options.origin??"https://pos.test",authorization:"Bearer "+await token(kind,id,options.expired)},
      body:JSON.stringify({saleId:receipt.saleId,actionId:id,...(endpoint==="actions/status"?{kind}:kind==="receipt"?{receipt:{...receipt,total:options.tamper?999:receipt.total}}:{})})});
  }
  return {calls,send,close:async()=>{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}};
}
test("authenticated HTTP submission, refreshed-token deduplication, status without replay, receipt-only reprint",async()=>{
  const h=await harness();
  try {
    assert.equal((await h.send("drawer/open","drawer",action.actionId)).status,202);
    assert.equal((await h.send("drawer/open","drawer",action.actionId)).status,202);
    assert.equal((await (await h.send("actions/status","drawer",action.actionId)).json() as {status:string}).status,"submitted");
    assert.equal((await h.send("receipt/print","receipt","pos:1:receipt:original")).status,202);
    assert.equal((await h.send("receipt/print","receipt","pos:1:receipt:"+crypto.randomUUID())).status,202);
    assert.deepEqual(h.calls,["drawer","receipt","receipt"]);
  }finally{await h.close();}
});
test("expired tokens, changed origin, invalid drawer identity and altered receipt cannot reach hardware",async()=>{
  const h=await harness();
  try{
    assert.equal((await h.send("drawer/open","drawer",action.actionId,{expired:true})).status,401);
    assert.equal((await h.send("drawer/open","drawer",action.actionId,{origin:"https://other.test"})).status,403);
    assert.equal((await h.send("drawer/open","drawer","pos:1:drawer:"+crypto.randomUUID())).status,403);
    assert.equal((await h.send("receipt/print","receipt","pos:1:receipt:original",{tamper:true})).status,403);
    assert.deepEqual(h.calls,[]);
  }finally{await h.close();}
});
test("drawer rate limit still rejects the seventh request without an extra pulse",async()=>{
  const h=await harness();
  try{for(let i=0;i<6;i++)assert.equal((await h.send("drawer/open","drawer",action.actionId)).status,202);
    assert.equal((await h.send("drawer/open","drawer",action.actionId)).status,429);assert.deepEqual(h.calls,["drawer"]);
  }finally{await h.close();}
});

test("definite pre-spool cooldown rejection remains distinct from uncertain output after restart",async()=>{
  const dir=await directory();let calls=0;
  try {
    await assert.rejects(new PosActionStore(dir).execute(action,async()=>{calls++;throw new BridgeError("drawer_cooldown","Cooling down.",429);}),
      (e:unknown)=>e instanceof BridgeError && e.code==="drawer_cooldown");
    assert.equal(await new PosActionStore(dir).status(action),"rejected");
    await assert.rejects(new PosActionStore(dir).execute(action,async()=>{calls++;}),
      (e:unknown)=>e instanceof BridgeError && e.code==="hardware_action_rejected");
    assert.equal(calls,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});
