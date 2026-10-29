import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import path from "node:path";
import os from "node:os";
import {mkdtemp,rm} from "node:fs/promises";
import { spawn } from "node:child_process";
import { fixture,pin } from "./offline-fixture.js";
import { createOfflineRouter } from "../src/offline/router.js";
import { OfflineHardware } from "../src/offline/hardware.js";
import type { PosPrinter } from "../src/printer.js";

test("real browser: local cold start and lost commit response recover after browser restart without duplicate sale or drawer", {timeout:120000},async()=>{
 const f=await fixture(),calls:string[]=[];
 const profile=await mkdtemp(path.join(os.tmpdir(),"smokehouse-pos-browser-test-"));
 const hardware=new OfflineHardware(f.journal,{
  getStatus:async()=>({configured:true,found:true,state:"available"}),cut:async()=>{},
  openDrawer:async()=>{calls.push("drawer");},printReceipt:async()=>{calls.push("receipt");}
 } as PosPrinter);
 const app=express();app.use(express.json());let origin="";
 app.use("/offline",createOfflineRouter({authority:f.authority,journal:f.journal,hardware,
  adminOrigin:"https://admin.test",get localOrigin(){return origin;},log:()=>{}}));
 const server=app.listen(0,"127.0.0.1");await new Promise<void>(r=>server.once("listening",r));
 origin="http://127.0.0.1:"+(server.address() as {port:number}).port;
 let child:ReturnType<typeof spawn>|undefined,socket:WebSocket|undefined,sequence=0;
 const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
 async function start(){
  child=spawn(process.env.POS_TEST_CHROME||"C:/Program Files/Google/Chrome/Application/chrome.exe",
   ["--headless=new","--no-sandbox","--no-first-run","--no-default-browser-check","--disable-background-networking","--disable-gpu","--disable-extensions","--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1","--remote-debugging-port=0","--user-data-dir="+profile,"about:blank"],
   {windowsHide:true,stdio:["ignore","ignore","pipe"]});
  const url=await new Promise<string>((resolve,reject)=>{
   let text="";const timeout=setTimeout(()=>reject(Error("Browser startup timed out")),20000);
   child!.once("error",e=>{clearTimeout(timeout);reject(e);});
   child!.stderr!.on("data",b=>{text+=b.toString();const match=text.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timeout);resolve(match[1]!);}});
  });
  socket=new WebSocket(url);await new Promise<void>((resolve,reject)=>{socket!.addEventListener("open",()=>resolve(),{once:true});socket!.addEventListener("error",()=>reject(Error("CDP unavailable")),{once:true});});
  socket.addEventListener("message",event=>{const message=JSON.parse(String(event.data));if(message.id){const callback=pending.get(message.id);pending.delete(message.id);if(message.error)callback?.reject(Error(message.error.message));else callback?.resolve(message.result);}});
 }
 function send(method:string,params:Record<string,unknown>={},sessionId?:string):Promise<any>{
  return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error("CDP timeout: "+method));},15000);
   pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
   socket!.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  });
 }
 async function evaluate(sessionId:string,expression:string){
  const r=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true},sessionId);
  if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;
 }
 async function until(work:()=>Promise<boolean>|boolean,description:string){
  const deadline=Date.now()+20000;while(Date.now()<deadline){if(await work())return;await new Promise(r=>setTimeout(r,50));}throw Error("Timed out: "+description);
 }
 async function open(){
  const {targetId}=await send("Target.createTarget",{url:origin+"/offline/"});
  const {sessionId}=await send("Target.attachToTarget",{targetId,flatten:true});
  await until(()=>evaluate(sessionId,"document.readyState==='complete' && typeof info!=='undefined' && !!info"),"local app boot");
  return sessionId as string;
 }
 async function login(sessionId:string){
  await evaluate(sessionId,"document.getElementById('cashier').value="+JSON.stringify(f.grant.cashierId)+";document.getElementById('pin').value="+JSON.stringify(pin)+";document.getElementById('signin').click();");
  await until(()=>evaluate(sessionId,"!document.getElementById('workspace').hidden"),"offline PIN login");
 }
 async function stop(){
  if(!child)return;const current=child,exited=new Promise<void>(resolve=>current.once("exit",()=>resolve()));
  const closing=send("Browser.close").catch(()=>{});
  await Promise.race([exited,new Promise(r=>setTimeout(r,3000))]);
  if(current.exitCode===null)current.kill();
  await Promise.race([exited,new Promise(r=>setTimeout(r,3000))]);
  socket?.close();for(const callback of pending.values())callback.reject(Error("Browser closed"));pending.clear();await closing;child=undefined;
 }
 let failure:unknown;
 try{
  await start();const first=await open();await login(first);
  await evaluate(first,`window.originalFetch=window.fetch;window.fetch=async function(url,...args){const response=await window.originalFetch.call(this,url,...args);if(String(url).endsWith("/commit"))return await new Promise(()=>{});return response;};
   const quantity=document.querySelector("#items input");quantity.value="1";quantity.dispatchEvent(new Event("input",{bubbles:true}));
   document.getElementById("cash").value="5000";document.getElementById("pay").click();`);
  await until(()=>f.journal.pendingCount()===1,"journal commitment despite lost browser response");
  await until(()=>calls.length===2,"mocked drawer-first receipt dispatch");assert.deepEqual(calls,["drawer","receipt"]);
  const id=f.journal.pending()[0]!.envelope.transactionId;
  await stop();await start();const restarted=await open();await login(restarted);
  await until(()=>evaluate(restarted,'document.getElementById("history").textContent.includes("pending")'),"restored cash history");
  assert.equal(f.journal.pendingCount(),1);assert.equal(f.journal.pending()[0]!.envelope.transactionId,id);
  assert.equal(await evaluate(restarted,'Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).filter(k=>k.startsWith("smokehouse-offline-pointer-v1:")).length'),0);
  assert.equal(await evaluate(restarted,'document.getElementById("cash").value'),"");
  await evaluate(restarted,'window.confirm=()=>true;document.querySelector("details").open=true;document.querySelector("#history button").click();');
  await until(()=>calls.length===3,"receipt-only reprint");assert.deepEqual(calls,["drawer","receipt","receipt"]);
  f.clock.now+=16*60*1000;
  await evaluate(restarted,'window.dispatchEvent(new Event("focus"));');
  await until(()=>evaluate(restarted,'!document.getElementById("login").hidden && document.getElementById("workspace").hidden'),"expired session returns to sign-in");
  await login(restarted);assert.equal(f.journal.pendingCount(),1);assert.deepEqual(calls,["drawer","receipt","receipt"]);
 }catch(error){failure=error;console.error("Offline browser test failure:",error);throw error;}finally{await stop();await new Promise<void>(r=>server.close(()=>r()));try{await f.cleanup();if(!profile.startsWith(path.join(os.tmpdir(),"smokehouse-pos-browser-test-")))throw Error("Unsafe profile cleanup");await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:500});}catch(error){if(failure)console.error("Browser fixture cleanup:",error);else throw error;}}
});
