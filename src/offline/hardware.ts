import type { PosPrinter } from "../printer.js";
import type { Grant } from "./contract.js";
import { OfflineJournal } from "./journal.js";

/** One terminal queue. Commitment never waits for spooler/PowerShell. */
export class OfflineHardware {
  private tail:Promise<void>=Promise.resolve();
  constructor(private journal:OfflineJournal,private printer:PosPrinter,private onError:(error:unknown)=>void=()=>{}) {}
  private async execute(id:string,kind:"drawer"|"receipt",grant:Grant,saleId:string) {
    const sale=this.journal.sale(grant,saleId);
    if(!sale || !this.journal.claim(id,kind)) return;
    try {
      if(kind==="drawer") await this.printer.openDrawer();
      else await this.printer.printReceipt(sale.envelope.receipt);
      this.journal.finish(id,"submitted");
    } catch(error) {
      // Even a local error after claim never becomes an automatic retry.
      this.journal.finish(id,"outcome_unknown","Check physical hardware; do not replay drawer.");
      this.onError(error);
    }
  }
  initial(grant:Grant,saleId:string):Promise<void> {
    const work=async()=>{
      try {await this.execute("offline:"+saleId+":drawer:original","drawer",grant,saleId);}
      finally {await this.execute("offline:"+saleId+":receipt:original","receipt",grant,saleId);}
    };
    const result=this.tail.then(work,work);this.tail=result.catch(this.onError);return result;
  }
  reprint(grant:Grant,saleId:string,requestId:string):Promise<void> {
    const id=this.journal.createReprint(grant,saleId,requestId);
    const work=()=>this.execute(id,"receipt",grant,saleId);
    const result=this.tail.then(work,work);this.tail=result.catch(this.onError);return result;
  }
}
