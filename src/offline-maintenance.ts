import "dotenv/config";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { inspectBackup } from "./offline/backup.js";

// Maintenance never constructs WindowsRawPosPrinter or executes any hardware method.
const operation=process.argv[2],source=process.argv[3],staging=process.argv[4];
const key=Buffer.from(process.env.OFFLINE_BACKUP_KEY_B64||"","base64url");
if(!source||key.length!==32)throw Error("Specify a backup path and OFFLINE_BACKUP_KEY_B64 (32 bytes).");
if(operation==="inspect") {
 if(!staging)throw Error("Specify a fresh staging file for recovery inspection.");
 console.log(inspectBackup(resolve(source),key,resolve(staging)));
} else if(operation==="backup") {
 const {startOffline}=await import("./offline/runtime.js");
 const forbidden=async()=>{throw Error("Hardware is unavailable in maintenance mode.");};
 const runtime=await startOffline(loadConfig(),{getStatus:forbidden,openDrawer:forbidden,printReceipt:forbidden,cut:forbidden},()=>{});
 try {console.log(runtime.journal.backup(resolve(source),key));}finally{runtime.close();}
} else throw Error("Use: offline-maintenance.js backup <new-file> OR inspect <backup-file> <new-staging-file>");
