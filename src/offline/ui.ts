// Served by the loopback bridge: cold-start works without the Admin cloud shell.
export function offlineHtml(nonce:string):string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Smokehouse local cash POS</title><style>
body{font:16px system-ui;background:#f5f4f0;color:#19251d;margin:auto;padding:20px;max-width:1100px}button,input{font:inherit;padding:12px;border:1px solid #bbb;border-radius:10px}button{cursor:pointer;background:#fff}button:disabled{opacity:.5;cursor:wait}section{background:white;padding:20px;border-radius:18px;margin:16px 0}.grid{display:grid;grid-template-columns:2fr 1fr;gap:20px}.items{display:grid;gap:12px}.line{display:flex;align-items:center;justify-content:space-between;gap:10px}.qty{width:65px}#message{white-space:pre-wrap;color:#702911}small{display:block;color:#555}button.primary{background:#1d653a;color:white}li{margin:12px 0}@media(max-width:700px){.grid{grid-template-columns:1fr}body{padding:10px}.line{flex-wrap:wrap}}
</style><h1>Smokehouse local cash POS</h1><p>Cash only · Saved on this terminal · Server synchronization is not available yet</p>
<p id="message" role="alert" aria-live="polite"></p>
<section id="login"><label>Cashier ID <input id="cashier" autocomplete="username"></label>
<label>Offline PIN <input id="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="12"></label><button id="signin">Sign in</button>
<small>Provision this terminal from the Admin dashboard while online. Offline authorization and reserved stock must be current.</small></section>
<main id="workspace" hidden><div class="line"><p id="summary"></p><button id="signout">Sign out</button></div>
<section id="recovery" hidden><p>An original request needs review. Do not record it as a replacement sale.</p><button id="retry">Check / retry original</button><button id="cancel">Cancel only if uncommitted</button></section>
<div class="grid"><section><h2>Allocated menu</h2><div id="items" class="items"></div></section>
<section><h2>Cash payment</h2><p id="total"></p><label>Cash received <input id="cash" type="number" min="0" step="1"></label><button class="primary" id="pay">Record cash sale</button></section></div>
<details><summary>Recent local cash sales</summary><ul id="history"></ul></details></main>
<script nonce="${nonce}">${clientScript}</script></html>`;
}
const clientScript=String.raw`
"use strict";
const $=id=>document.getElementById(id);
let token=sessionStorage.getItem("smokehouse-offline-session")||"",info,catalog,busy=false,pointerKey="",pending=null;
const quantities=new Map();
$("cashier").value=location.hash.slice(1)||localStorage.getItem("smokehouse-offline-cashier")||"";
function message(text){$("message").textContent=text;}
async function api(route,body){
 const res=await fetch("/offline/"+route,{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:JSON.stringify(body||{}),signal:AbortSignal.timeout(12000)});
 const result=await res.json();if(!res.ok){
  if(res.status===401||result.error?.code==="grant_expired"){token="";sessionStorage.removeItem("smokehouse-offline-session");$("login").hidden=false;$("workspace").hidden=true;}
  throw Error(result.error?.message||"Operation unavailable. Preserve the original request.");
 }
 return result;
}
function total(){return (catalog?.items||[]).reduce((n,i)=>n+i.unitPrice*(quantities.get(i.menuItemId)||0),0);}
function locks(){document.querySelectorAll("#workspace input,#pay").forEach(e=>e.disabled=busy||!!pending);$("retry").disabled=busy;$("cancel").disabled=busy;$("signout").disabled=busy;}
async function refresh(){
 const state=await api("state");catalog=state.catalog;pointerKey="smokehouse-offline-pointer-v1:"+info.terminalId+":"+info.epoch+":"+catalog.cashierId;
 const pointer=localStorage.getItem(pointerKey);
 pending=state.draft;
 if(pointer){
   const result=await api("lookup",{transactionId:pointer});
   if(result.sale){localStorage.removeItem(pointerKey);quantities.clear();$("cash").value="";message("Recorded locally: "+result.sale.envelope.receipt.saleId+". Cloud sync pending. Change: USh "+result.sale.envelope.changeGiven);}
   else pending=state.draft||{transactionId:pointer};
 }
 $("login").hidden=true;$("workspace").hidden=false;$("recovery").hidden=!pending;
 $("summary").textContent="Authorization expires "+new Date(catalog.expiresAt).toLocaleString()+". "+state.pendingCount+" terminal sales awaiting sync.";
 $("items").replaceChildren();
 for(const item of catalog.items){
  const row=document.createElement("div");row.className="line";
  const name=document.createElement("span");name.textContent=item.name+" · USh "+item.unitPrice+" · "+item.available+" allocated";
  const qty=document.createElement("input");qty.className="qty";qty.type="number";qty.min="0";qty.max=String(Math.min(20,item.available));qty.step="1";qty.setAttribute("aria-label",item.name+" quantity");
  qty.value=String(Math.min(quantities.get(item.menuItemId)||0,item.available));
  quantities.set(item.menuItemId,Number(qty.value));
  qty.oninput=()=>{const n=Number(qty.value);quantities.set(item.menuItemId,Number.isInteger(n)&&n>=0&&n<=Math.min(20,item.available)?n:0);$("total").textContent="Total: USh "+total();};
  row.append(name,qty);$("items").append(row);
 }
 $("total").textContent="Total: USh "+total();$("history").replaceChildren();
 for(const sale of state.history){
  const li=document.createElement("li"),text=document.createElement("span"),button=document.createElement("button");
  text.textContent=sale.envelope.receipt.saleId+" · USh "+sale.envelope.receipt.total+" · "+sale.syncState+" · "+sale.hardware.map(h=>h.kind+": "+h.state).join(", ");
  button.textContent="Reprint receipt only";button.onclick=()=>run(async()=>{
   if(!confirm("Print an additional receipt? The drawer stays closed."))return;
   await api("reprint",{transactionId:sale.envelope.transactionId,requestId:crypto.randomUUID()});message("Receipt-only request submitted. Check its status.");await refresh();
  });li.append(text,button);$("history").append(li);
 }
 locks();
}
async function run(work){if(busy)return;busy=true;locks();try{await work();}catch(error){message(error.message);}finally{busy=false;locks();}}
$("signin").onclick=()=>run(async()=>{
 const result=await api("login",{cashierId:$("cashier").value.trim(),pin:$("pin").value});
 quantities.clear();$("cash").value="";token=result.token;sessionStorage.setItem("smokehouse-offline-session",token);localStorage.setItem("smokehouse-offline-cashier",$("cashier").value.trim());$("pin").value="";await refresh();
});
$("signout").onclick=()=>run(async()=>{await api("logout");token="";sessionStorage.removeItem("smokehouse-offline-session");location.reload();});
$("pay").onclick=()=>run(async()=>{
 if(pending)throw Error("Recover the original request first.");
 const amount=Number($("cash").value),sum=total();
 if(!sum||!Number.isSafeInteger(amount)||amount<sum)throw Error("Select items and enter enough cash.");
 const input={transactionId:crypto.randomUUID(),catalogVersion:catalog.catalogVersion,expectedTotal:sum,amountReceived:amount,
 items:catalog.items.filter(i=>(quantities.get(i.menuItemId)||0)>0).map(i=>({menuItemId:i.menuItemId,quantity:quantities.get(i.menuItemId)}))};
 localStorage.setItem(pointerKey,input.transactionId);pending=input;locks();
 try{await api("prepare",input);const result=await api("commit",input);message("Recorded locally: "+result.sale.envelope.receipt.saleId+". Change: USh "+result.sale.envelope.changeGiven+". Synchronization pending.");localStorage.removeItem(pointerKey);quantities.clear();$("cash").value="";}
 finally{await refresh();}
});
$("retry").onclick=()=>run(async()=>{
 await refresh();if(!pending)return;
 const outcome=await api("lookup",{transactionId:pending.transactionId});
 if(outcome.sale){localStorage.removeItem(pointerKey);quantities.clear();$("cash").value="";await refresh();return;}
 if(!pending.items)throw Error("No prepared sale found. Cancel this uncommitted pointer before starting again.");
 await api("commit",pending);localStorage.removeItem(pointerKey);quantities.clear();$("cash").value="";await refresh();
});
$("cancel").onclick=()=>run(async()=>{if(!pending)return;await api("cancel",{transactionId:pending.transactionId});localStorage.removeItem(pointerKey);pending=null;await refresh();});
window.addEventListener("focus",()=>{if(token&&!busy)void run(refresh);});
fetch("/offline/info").then(r=>r.json()).then(v=>{info=v;if(token)return run(refresh);}).catch(e=>message(e.message));
`;
