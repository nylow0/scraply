import { expect, test } from "@playwright/test";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ScraplyApi } from "../../src/preload/index";
import { createInstalledApp } from "./installed-app";

// Opt-in local snapshots only. Never open or mutate the user's original database.
test("existing projects load in the installed app from isolated credential-free snapshots",async()=>{
  test.skip(!process.env.SCRAPLY_ACCEPTANCE_SNAPSHOTS,"Requires explicitly prepared local snapshots");
  const snapshots=z.array(z.object({name:z.string(),snapshot:z.string(),threads:z.array(z.object({id:z.string(),title:z.string(),visibleSolutionCount:z.number().int().nonnegative()})),count:z.object({n:z.number()})})).parse(JSON.parse(readFileSync(process.env.SCRAPLY_ACCEPTANCE_SNAPSHOTS!,"utf8")));
  for(const snapshot of snapshots) {
    const app=createInstalledApp({directoryPrefix:"scraply-saved-compatibility-"});
    mkdirSync(join(app.directory,"scraply"));
    copyFileSync(snapshot.snapshot,join(app.directory,"scraply/scraply.db"));
    const env=Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string]=>entry[1]!==undefined));
    for(const key of Object.keys(env)) if(key.startsWith("SCRAPLY_E2E")||key.startsWith("SCRAPLY_RUNTIME")||["EXA_API_KEY","PERPLEXITY_API_KEY"].includes(key)) delete env[key];
    env.SCRAPLY_E2E="1";
    try {
      const electron=await app.launch(env);
      const page=await electron.firstWindow();
      await page.getByRole("button",{name:`Open thread ${snapshot.threads[0]!.title}`,exact:true}).waitFor();
      const workspace=await page.evaluate(()=> (window as unknown as {scraply:ScraplyApi}).scraply.getWorkspace());
      expect(workspace.threads).toHaveLength(snapshot.count.n);
      expect(workspace.validation.native.connected).toBe(false);
      expect(workspace.validation.exa.valid).toBe(false);
      for(const thread of snapshot.threads) {
        await page.getByRole("button",{name:`Open thread ${thread.title}`,exact:true}).click();
        await expect(page.getByRole("heading",{name:thread.title,exact:true})).toBeVisible();
        const saved=await page.evaluate(()=> (window as unknown as {scraply:ScraplyApi}).scraply.getWorkspace());
        expect(saved.activeThreadId).toBe(thread.id);
        // A failed legacy run can contain partial SQL rows without completed ideas.
        // Compare against the prepared snapshot, including this zero-result case.
        expect(saved.solutions).toHaveLength(thread.visibleSolutionCount);
        if (saved.solutions[0]) {
          const detail=await page.evaluate(async id=>(window as unknown as {scraply:ScraplyApi}).scraply.getIdeaDetail(id),saved.solutions[0].id);
          expect(detail.id).toBe(saved.solutions[0].id);
          expect(detail.detailsLoaded).toBe(true);
        } else {
          expect(saved.latestResearchRun?.status).toBe("failed");
          expect(saved.problemCandidates.length).toBeGreaterThan(0);
        }
      }
      await page.reload();
      await expect(page.getByRole("heading",{name:snapshot.threads.at(-1)!.title,exact:true})).toBeVisible();
    } finally {await app.cleanup();}
  }
});
