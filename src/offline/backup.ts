import { createDecipheriv } from "node:crypto";
import { readFileSync,writeFileSync,existsSync,chmodSync,unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { OfflineError } from "./contract.js";

/** Recovery foundation: inspect in a NEW staging file, never replace the active terminal.
 * Activation requires terminal fencing, identity/sequence reconciliation and operator review. */
export function inspectBackup(source:string,recoveryKey:Buffer,stagingFile:string) {
 if(recoveryKey.length!==32||existsSync(stagingFile))throw new OfflineError("restore_invalid","Use a fresh staging path and 32-byte key.");
 const bytes=readFileSync(source);
 if(bytes.length<35||bytes.subarray(0,6).toString()!=="SHPOS1")throw new OfflineError("restore_invalid","Unsupported backup.");
 const decipher=createDecipheriv("aes-256-gcm",recoveryKey,bytes.subarray(6,18));
 decipher.setAAD(Buffer.from("smokehouse-offline-backup-v1"));decipher.setAuthTag(bytes.subarray(18,34));
 const plain=Buffer.concat([decipher.update(bytes.subarray(34)),decipher.final()]);
 writeFileSync(stagingFile,plain,{flag:"wx",mode:0o600});chmodSync(stagingFile,0o600);
 let db:DatabaseSync|undefined;
 try{
  db=new DatabaseSync(stagingFile,{readOnly:true});
  if((db.prepare("PRAGMA integrity_check").get() as {integrity_check:string}).integrity_check!=="ok")throw Error("Backup integrity check failed.");
  if(Number((db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version)!==1)throw Error("Unsupported backup schema.");
  const meta=Object.fromEntries(db.prepare("SELECT key,value FROM meta").all().map(r=>[String(r.key),String(r.value)]));
  const pending=Number((db.prepare("SELECT count(*) AS count FROM outbox WHERE state<>'acknowledged'").get() as {count:number}).count);
  return {terminalId:meta.terminalId,epoch:meta.epoch,sequence:Number(meta.sequence),pending};
 } finally {db?.close();unlinkSync(stagingFile);}
}
