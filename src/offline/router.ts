import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { z, ZodError } from "zod";
import { canonical, OfflineError } from "./contract.js";
import type { OfflineAuthority } from "./security.js";
import type { OfflineJournal } from "./journal.js";
import type { OfflineHardware } from "./hardware.js";
import { offlineHtml } from "./ui.js";
import { randomBytes } from "node:crypto";

export function createOfflineRouter(deps:{
  authority:OfflineAuthority;journal:OfflineJournal;hardware:OfflineHardware;
  adminOrigin:string;localOrigin:string;log:(e:unknown)=>void;
}) {
  const router=Router();
  router.use((_req,res,next)=>{res.setHeader("Cache-Control","no-store");next();});
  router.get("/",(_req,res)=>{
    const nonce=randomBytes(18).toString("base64");
    res.setHeader("Content-Security-Policy","default-src 'none'; script-src 'nonce-"+nonce+"'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader("X-Content-Type-Options","nosniff");
    res.type("html").send(offlineHtml(nonce));
  });
  router.get("/info",async(req,res,next)=>{
    try { const nonce=req.query.nonce?z.uuid().toLowerCase().parse(req.query.nonce):undefined;
    res.json({version:1,terminalId:deps.authority.terminalId,epoch:deps.authority.epoch,publicJwk:deps.authority.publicJwk, ...(nonce?{proof:await deps.authority.enrollmentProof(nonce)}:{})});
    }catch(error){next(error);}
  });
  const origin:RequestHandler=(req,_res,next)=>{
    if(![deps.adminOrigin,deps.localOrigin].includes(req.header("origin")||""))
      return next(new OfflineError("origin_rejected","Allowed browser Origin required.",403));
    next();
  };
  router.post("/provision",origin,rateLimit({windowMs:60_000,limit:5}),async(req,res,next)=>{
    try {
      if(req.header("origin")!==deps.adminOrigin) throw new OfflineError("origin_rejected","Provision from the signed-in Admin dashboard.",403);
      const body=z.object({token:z.string().max(100_000),pin:z.string().regex(/^\d{8,12}$/)}).strict().parse(req.body);
      const grant=await deps.authority.verifyGrant(body.token,Date.now());
      await deps.journal.install(body.token,body.pin);
      res.status(201).json({ok:true,cashierId:grant.cashierId,expiresAt:grant.expiresAt});
    }catch(error){next(error);}
  });
  router.post("/login",origin,rateLimit({windowMs:15*60_000,limit:5}), (req,res,next)=>{
    try {
      const body=z.object({cashierId:z.uuid(),pin:z.string().max(12)}).strict().parse(req.body);
      res.json({token:deps.journal.login(body.cashierId,body.pin)});
    }catch(error){next(error);}
  });
  const authorized:RequestHandler=(req,res,next)=>{
    try {
      const token=req.header("authorization")?.replace(/^Bearer /,"")||"";
      res.locals.grant=deps.journal.session(token);next();
    }catch(error){next(error);}
  };
  router.use(origin,authorized);
  router.post("/logout",(req,res)=>{deps.journal.logout(req.header("authorization")!.slice(7));res.json({ok:true});});
  router.post("/state",(_req,res)=>{
    const g=res.locals.grant;
    res.json({catalog:deps.journal.catalog(g),draft:deps.journal.draft(g),history:deps.journal.history(g),pendingCount:deps.journal.pendingCount()});
  });
  router.post("/prepare",(req,res,next)=>{
    try{res.json({input:deps.journal.prepare(res.locals.grant,req.body)});}catch(e){next(e);}
  });
  router.post("/commit",(req,res,next)=>{
    try {
      const result=deps.journal.commit(res.locals.grant,req.body);
      res.status(result.duplicate?200:201).json({...result,syncState:"pending"});
      // Only the original commit may initiate drawer hardware. Duplicate delivery never does.
      if(!result.duplicate) void deps.hardware.initial(res.locals.grant,result.sale.envelope.transactionId).catch(deps.log);
    }catch(e){next(e);}
  });
  router.post("/lookup",(req,res,next)=>{
    try{const id=z.object({transactionId:z.uuid()}).strict().parse(req.body).transactionId;
      res.json({sale:deps.journal.sale(res.locals.grant,id),hardware:deps.journal.sale(res.locals.grant,id)?deps.journal.hardware(id):[]});
    }catch(e){next(e);}
  });
  router.post("/cancel",(req,res,next)=>{
    try {deps.journal.cancel(res.locals.grant,z.object({transactionId:z.uuid()}).strict().parse(req.body).transactionId);res.json({ok:true});}
    catch(e){next(e);}
  });
  router.post("/reprint",(req,res,next)=>{
    try {
      const b=z.object({transactionId:z.uuid(),requestId:z.uuid()}).strict().parse(req.body);
      void deps.hardware.reprint(res.locals.grant,b.transactionId,b.requestId).catch(deps.log);
      res.status(202).json({ok:true});
    }catch(e){next(e);}
  });
  router.use((error:unknown,_req:unknown,res:import("express").Response,_next:unknown)=>{
    if(error instanceof OfflineError) return void res.status(error.status).json({error:{code:error.code,message:error.message}});
    if(error instanceof ZodError) return void res.status(422).json({error:{code:"invalid_request",message:"Invalid offline request."}});
    deps.log(error);res.status(503).json({error:{code:"offline_unavailable",message:"Offline operation unavailable. Preserve the request and check the original outcome."}});
  });
  return router;
}
