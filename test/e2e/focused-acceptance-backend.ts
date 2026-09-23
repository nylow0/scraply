import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { z } from "zod";
import { DatabaseClient } from "../../src/db/client";
import { FocusedExperimentRepository } from "../../src/db/repositories/focused-experiments";
import { runFocusedExperimentFlow } from "../../src/core/experiment-review";
import { DEFAULT_RUN_CONFIG } from "../../src/shared/schemas";
import { WorkspaceStateSchema, type WorkspaceState } from "../../src/shared/ipc";
import type { StructuredModelClient, StructuredStageRequest } from "../../src/providers/structured";
import { acceptanceReview, savedPaymentDraft, validPaymentPlan } from "../fixtures/focused-acceptance";

/** Isolated SQLite + real planning flow. All model results are local fixtures. */
export async function startFocusedAcceptanceBackend(directory: string) {
  const db = new DatabaseClient(join(directory,"scraply.db"));
  const repository = new FocusedExperimentRepository(db);
  const now = new Date().toISOString();
  const titles = { invalid:"Invalid numeric draft", valid:"Valid payment experiment", legacy:"Saved legacy experiment" };
  let active: keyof typeof titles = "invalid";
  let fixtureCalls = 0;
  for (const [id,title] of Object.entries(titles)) {
    db.db.prepare("INSERT INTO threads (id,title,status,created_at,updated_at) VALUES (?,?,'solutions-ready',?,?)").run(id,title,now,now);
    db.db.prepare("INSERT INTO research_runs (id,thread_id,status,config_json,created_at,updated_at) VALUES (?,?,'completed','{}',?,?)").run(`discovery-${id}`,id,now,now);
    db.db.prepare("INSERT INTO problems (id,discovery_run_id,statement,why_it_persists,affected,scale_estimate,verdict,verdict_reason,verdict_source_ids_json,created_at) VALUES (?,?,'Release status is unclear','Manual coordination','Small teams','Unknown','insufficient-evidence','Fixture','[]',?)").run(`problem-${id}`,`discovery-${id}`,now);
    db.db.prepare("INSERT INTO research_runs (id,thread_id,problem_id,status,config_json,workflow_version,created_at,updated_at) VALUES (?,?,?,'completed',?,2,?,?)").run(`run-${id}`,id,`problem-${id}`,JSON.stringify(DEFAULT_RUN_CONFIG),now,now);
    db.db.prepare("INSERT INTO solutions (id,research_run_id,problem_id,mechanism,description,respects_off_limits,respects_off_limits_why,selected_at,created_at) VALUES (?,?,?,'Release ledger','Inspect the saved payment experiment',1,'Offline fixture',?,?)").run(`solution-${id}`,`run-${id}`,`problem-${id}`,now,now);
  }
  const oldRecord = {schemaVersion:1,status:"approved",plan:savedPaymentDraft,initialReview:acceptanceReview("approved"),finalReview:null,correctionCount:0};
  db.db.prepare("INSERT INTO focused_experiments (id,research_run_id,solution_id,status,record_json,created_at,updated_at) VALUES ('legacy','run-legacy','solution-legacy','approved',?,?,?)").run(JSON.stringify(oldRecord),now,now);
  const validation:WorkspaceState["validation"]={exa:{valid:false},perplexity:{valid:false},native:{available:true,connected:true,accounts:[{providerId:"openai-subscription"}]},setupComplete:true};
  const workspace = ():WorkspaceState => WorkspaceStateSchema.parse({
    validation, threads:Object.entries(titles).map(([id,title])=>({id,title,status:"solutions-ready",createdAt:now,updatedAt:now})),activeThreadId:active,
    messages:[],scope:null,runConfig:DEFAULT_RUN_CONFIG,models:[DEFAULT_RUN_CONFIG.model],modelOptions:[{...DEFAULT_RUN_CONFIG.model,displayName:"Offline fixture",defaultReasoningEffort:"medium",reasoningEfforts:[{id:"medium",description:"Fixture"}]}],modelCatalog:{models:[DEFAULT_RUN_CONFIG.model],favorites:[]},presets:[],problemCandidates:[],rejectedProblemCandidates:[],researchRequests:[],researchFindings:[],latestResearchRun:null,pendingRuns:[],
    solutions:[{id:`solution-${active}`,problemId:`problem-${active}`,problemStatement:"Release status is unclear",problemVerdict:"insufficient-evidence",workflowVersion:2,runId:`run-${active}`,selected:true,selectable:false,detailsLoaded:true,detailRevision:String(fixtureCalls),mechanism:"Release ledger",description:"Inspect the saved payment experiment",respectsOffLimits:true,respectsOffLimitsWhy:"Offline fixture",factors:[],outcomes:[],risks:[],confirmedCoreOutcomes:0,unaddressedCatastrophicRisks:0,
      focusedExperiment:repository.findRecord(`run-${active}`,`solution-${active}`),experimentOutcome:"not-run",decisionAnalysis:{consequences:[],risks:[],proposedResponses:[],unknowns:[],experiment:{question:"Will buyers pay?",method:"Observe actual payment",cost:"Offline fixture",passCriterion:"Payment",failCriterion:"No payment",inconclusiveCriterion:"Insufficient observations"}}}],
  });
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url??"/","http://127.0.0.1");
      const chunks:Buffer[]=[];
      for await(const chunk of req) chunks.push(Buffer.from(chunk));
      const body:unknown=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
      if(url.pathname==="/threads/select") active=z.object({threadId:z.enum(["invalid","valid","legacy"])}).parse(body).threadId;
      if(url.pathname==="/experiments/plan") {
        const id=active;
        const expected=z.object({threadId:z.literal(id),runId:z.literal(`run-${id}`),solutionId:z.literal(`solution-${id}`)}).parse(body);
        const modelClient:StructuredModelClient={async structuredCompletion<T>(request:StructuredStageRequest<T>){
          fixtureCalls++;
          const output=request.stage.endsWith("draft") ? id==="invalid" ? {...savedPaymentDraft,outcomeRules:{...savedPaymentDraft.outcomeRules,metricRange:{minimum:0,maximum:100}}} : validPaymentPlan() : acceptanceReview("approved");
          return {output:request.schema.parse(output),metadata:{model:request.model,usage:{status:"unknown"},latencyMs:0,repairCount:0,providerRequestIds:[],attempts:[]}};
        }};
        await runFocusedExperimentFlow({researchRunId:expected.runId,context:{scope:{title:titles[id],audience:"Small teams",domain:"Developer tools",observations:"Saved fixture",offLimits:[]},problem:{id:`problem-${id}`,statement:"Release status is unclear",whyItPersists:"Manual coordination",affected:"Small teams",scaleEstimate:"Unknown",scaleBasisFactorId:null,factorIds:[],verdict:"insufficient-evidence",verdictReason:"Fixture",verdictSourceIds:[]},supportingEvidence:[],contraryEvidence:[],priorFailedAttempts:[]},selectedOption:{id:expected.solutionId,problemId:`problem-${id}`,mechanism:"Release ledger",description:"Saved experiment",keyAssumption:"Buyers will pay",whyCurrentApproachMaySuffice:"Existing CI views",supportingEvidenceIds:[],contraryEvidenceIds:[],unknowns:[],respectsOffLimits:true,respectsOffLimitsWhy:"Fixture"},riskEvaluation:{risks:[{riskId:"payment",description:"Buyers may not pay",whyDecisive:"Stops build"}],unknowns:[]}}, {repository,modelClient,generationModel:DEFAULT_RUN_CONFIG.model,reviewModel:DEFAULT_RUN_CONFIG.model,generationReasoningEffort:"medium",reviewReasoningEffort:"medium"});
      }
      res.setHeader("content-type","application/json");
      const data=url.pathname==="/validation"?validation:url.pathname.startsWith("/ideas/")?workspace().solutions[0]:workspace();
      res.end(JSON.stringify({ok:true,data}));
    } catch(error) {
      res.writeHead(422,{"content-type":"application/json"});
      res.end(JSON.stringify({ok:false,error:{code:"validation_error",message:error instanceof Error?error.message:"Fixture failed"}}));
    }
  });
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const address=server.address(); if(!address||typeof address==="string") throw new Error("Fixture server unavailable");
  return {url:`http://127.0.0.1:${address.port}`,token:"offline-acceptance",workspace,fixtureCallCount:()=>fixtureCalls,close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));db.close();}};
}
