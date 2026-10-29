import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { randomUUID } from "node:crypto";
import { fixture,pin } from "./offline-fixture.js";
import { createOfflineRouter } from "../src/offline/router.js";
import { OfflineHardware } from "../src/offline/hardware.js";
import type { PosPrinter } from "../src/printer.js";
test("HTTP commitment acknowledges before hardware; origin/auth, duplicate delivery and reprint remain isolated",async()=>{
 const f=await fixture(),calls:string[]=[];let release!:()=>void;
 const gate=new Promise<void>(r=>{release=r;});
 const printer={getStatus:async()=>({configured:true,found:true,state:"available"}),cut:async()=>{},
 openDrawer:async()=>{calls.push("drawer");await gate;},printReceipt:async()=>{calls.push("receipt");}} as PosPrinter;
 const hardware=new OfflineHardware(f.journal,printer);
 const app=express();app.use(express.json());let origin="";
 app.use("/offline",createOfflineRouter({authority:f.authority,journal:f.journal,hardware,
 adminOrigin:"https://admin.test",get localOrigin(){return origin;},log:()=>{}}));
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
 origin="http://127.0.0.1:"+(server.address() as {port:number}).port;
 let token="";
 async function post(route:string,body:unknown={},customOrigin=origin,customToken=token){
  return fetch(origin+"/offline/"+route,{method:"POST",headers:{"Content-Type":"application/json",Origin:customOrigin,Authorization:"Bearer "+customToken},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
 }
 try{
  const ui=await fetch(origin+"/offline/");assert.equal(ui.status,200);assert.match(ui.headers.get("content-security-policy")!,/frame-ancestors 'none'/);
  assert.match(await ui.text(),/original request/i);
  assert.equal((await post("state")).status,401);
  assert.equal((await post("login",{cashierId:f.grant.cashierId,pin},"https://evil.test")).status,403);
  const login=await post("login",{cashierId:f.grant.cashierId,pin});token=(await login.json()).token;
  assert.ok(token);
  assert.equal((await post("reprint",{transactionId:randomUUID(),requestId:randomUUID()})).status,403);
  const input=f.input();assert.equal((await post("prepare",input)).status,200);
  const committed=await post("commit",input);assert.equal(committed.status,201);const result=await committed.json();
  assert.equal(result.syncState,"pending");assert.equal(result.sale.envelope.transactionId,input.transactionId);
  await new Promise(r=>setImmediate(r));assert.deepEqual(calls,["drawer"]);
  const duplicate=await post("commit",input);assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).duplicate,true);
  release();await new Promise(r=>setTimeout(r,30));assert.deepEqual(calls,["drawer","receipt"]);
  assert.equal((await post("lookup",{transactionId:input.transactionId})).status,200);
  const reprint={transactionId:input.transactionId,requestId:randomUUID()};
  await post("reprint",reprint);await post("reprint",reprint);await new Promise(r=>setTimeout(r,30));
  assert.deepEqual(calls,["drawer","receipt","receipt"]);
  const state=await (await post("state")).json();assert.equal(state.pendingCount,1);assert.equal(state.draft,null);
  assert.equal(state.history.length,1);
 }finally{release();await new Promise<void>(r=>server.close(()=>r()));await f.cleanup();}
});
