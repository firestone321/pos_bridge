import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SignJWT, importJWK, type JWK } from "jose";
import { OfflineAuthority } from "../src/offline/security.js";
import { OfflineJournal } from "../src/offline/journal.js";
import { kampalaDate, type Grant, type CashInput } from "../src/offline/contract.js";
export const pin="91827364";
export async function fixture(quantity=3) {
 const directory=await mkdtemp(path.join(os.tmpdir(),"smokehouse-offline-test-"));
 const cloud=generateKeyPairSync("ed25519"),terminal=generateKeyPairSync("ed25519");
 const publicJwk=cloud.publicKey.export({format:"jwk"}) as JWK;
 const privateJwk=terminal.privateKey.export({format:"jwk"});
 const terminalId=randomUUID(),epoch=randomUUID();
 const authority=await OfflineAuthority.create(terminalId,epoch,"test-issuer",privateJwk,publicJwk);
 const clock={now:Date.UTC(2026,9,29,10)};
 const grant:Grant={version:1,grantId:randomUUID(),terminalId,epoch,terminalKey:await authority.thumbprint(),
 cashierId:randomUUID(),permissions:["cash","reprint"],allocationId:randomUUID(),catalogVersion:randomUUID(),
 serviceDate:kampalaDate(clock.now),issuedAt:clock.now,expiresAt:clock.now+60*60*1000,
 items:[{menuItemId:1,name:"Test water",unitPrice:2000,requirements:[{resourceId:1,quantity:1}]}],
 budgets:[{resourceId:1,quantity}]};
 async function token(g=grant,key=cloud.privateKey.export({format:"jwk"}) as JWK) {
  return new SignJWT({grant:g}).setProtectedHeader({alg:"EdDSA"}).setIssuer("test-issuer")
   .setAudience("smokehouse-offline-pos-v1").setIssuedAt(g.issuedAt/1000).setExpirationTime(g.expiresAt/1000).sign(await importJWK(key,"EdDSA"));
 }
 const filename=path.join(directory,"journal.sqlite");
 let journal=new OfflineJournal(filename,authority,()=>clock.now);
 const signed=await token();await journal.install(signed,pin);
 const input=(qty=1):CashInput=>({transactionId:randomUUID(),catalogVersion:grant.catalogVersion,expectedTotal:2000*qty,amountReceived:5000*qty,items:[{menuItemId:1,quantity:qty}]});
 return {directory,filename,authority,grant,clock,token,signed,input,privateJwk,publicJwk,cloud,
 get journal(){return journal;},
 reopen(){journal.close();journal=new OfflineJournal(filename,authority,()=>clock.now);return journal;},
 async cleanup(){journal.close();await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:500});}};
}
