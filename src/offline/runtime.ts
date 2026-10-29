import path from "node:path";
import { openSync,closeSync,writeSync,readFileSync,unlinkSync,fsyncSync,mkdirSync } from "node:fs";
import { z } from "zod";
import type { BridgeConfig } from "../config.js";
import type { PosPrinter } from "../printer.js";

/** Dynamic import means Phase 2 does not require node:sqlite when offline is disabled. */
export async function startOffline(config:BridgeConfig,printer:PosPrinter,log:(e:unknown)=>void) {
  if(Number(process.versions.node.split(".")[0])<24) throw Error("Offline cash POS requires Node 24 LTS or newer; Phase 2 remains compatible with its existing runtime.");
  const terminalId=z.uuid().toLowerCase().parse(process.env.OFFLINE_TERMINAL_ID);
  const epoch=z.uuid().toLowerCase().parse(process.env.OFFLINE_TERMINAL_EPOCH);
  const issuer=z.string().min(1).parse(process.env.OFFLINE_GRANT_ISSUER);
  const localOrigin="http://127.0.0.1:"+config.port;
  const configuredDirectory=z.string().min(1).parse(process.env.OFFLINE_DATA_DIR);
  if(!path.isAbsolute(configuredDirectory)||configuredDirectory.startsWith("\\\\")||/onedrive/i.test(configuredDirectory))
    throw Error("OFFLINE_DATA_DIR must be an absolute local-disk path outside OneDrive/network shares.");
  const directory=path.resolve(configuredDirectory);
  mkdirSync(directory,{recursive:true,mode:0o700});
  const lockPath=path.join(directory,"writer.lock");
  try {
    const prior=JSON.parse(readFileSync(lockPath,"utf8")) as {pid:number};
    try {process.kill(prior.pid,0);throw Error("Another offline journal owner is running.");}
    catch(e) {if((e as NodeJS.ErrnoException).code!=="ESRCH") throw e;}
    unlinkSync(lockPath);
  }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  const lock=openSync(lockPath,"wx",0o600);writeSync(lock,JSON.stringify({pid:process.pid}));fsyncSync(lock);
  let closeJournal:(()=>void)|undefined;
  const close=()=>{closeJournal?.();closeSync(lock);unlinkSync(lockPath);};
  try {
    const [{OfflineAuthority},{OfflineJournal},{OfflineHardware},{createOfflineRouter}]=await Promise.all([
      import("./security.js"),import("./journal.js"),import("./hardware.js"),import("./router.js")
    ]);
    const privateJwk=JSON.parse(Buffer.from(z.string().min(1).parse(process.env.OFFLINE_TERMINAL_PRIVATE_JWK_B64),"base64url").toString("utf8"));
    const trusted=JSON.parse(Buffer.from(z.string().min(1).parse(process.env.OFFLINE_GRANT_PUBLIC_JWK_B64),"base64url").toString("utf8"));
    const authority=await OfflineAuthority.create(terminalId,epoch,issuer,privateJwk,trusted);
    const journal=new OfflineJournal(path.join(directory,"journal.sqlite"),authority,Date.now,config.drawerCooldownMs);
    closeJournal=()=>journal.close();
    journal.recoverHardware();
    const hardware=new OfflineHardware(journal,printer,log);
    return {journal,router:createOfflineRouter({authority,journal,hardware,adminOrigin:config.allowedOrigin,localOrigin,log}),close};
  }catch(error){close();throw error;}
}
