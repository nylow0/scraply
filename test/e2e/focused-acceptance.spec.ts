import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { createInstalledApp } from "./installed-app";

test("installed UI rejects invalid planning, displays valid strict rules, and preserves a saved legacy plan",async({},testInfo)=>{
  const app=createInstalledApp({directoryPrefix:"scraply-focused-acceptance-"});
  // Bundle the local fixture as CJS, matching the app's backend environment.
  // Its imports include the production prompt loader, which uses __dirname.
  const bundle=join(app.directory,"offline-backend.cjs");
  await promisify(execFile)("bun",["build","./test/e2e/focused-acceptance-backend.ts","--target=node","--format=cjs","--external=bun:sqlite",`--outfile=${bundle}`]);
  const fixture=createRequire(import.meta.url)(bundle) as typeof import("./focused-acceptance-backend");
  const backend=await fixture.startFocusedAcceptanceBackend(app.directory);
  try {
    const electron=await app.launch({...process.env,SCRAPLY_E2E:"1",SCRAPLY_E2E_BACKEND_URL:backend.url,SCRAPLY_E2E_BACKEND_TOKEN:backend.token});
    const page=await electron.firstWindow();
    await page.getByRole("button",{name:"Inspect the saved payment experiment",exact:true}).click();
    await page.getByRole("button",{name:"Plan a focused experiment",exact:true}).click();
    await expect(page.locator("div[role='alert']")).toContainText("Numeric rules must allow both pass and fail");
    expect(backend.workspace().solutions[0]?.focusedExperiment).toBeNull();
    expect(backend.fixtureCallCount()).toBe(1);
    await page.getByRole("button",{name:"Open thread Valid payment experiment",exact:true}).click();
    await page.getByRole("button",{name:"Inspect the saved payment experiment",exact:true}).click();
    await page.getByRole("button",{name:"Plan a focused experiment",exact:true}).click();
    const plan=page.getByRole("region",{name:"Focused experiment"});
    await expect(plan.getByText("Reviewed",{exact:true})).toBeVisible();
    await expect(plan.getByText("0 to 100 percent of usable offers",{exact:true})).toBeVisible();
    await expect(plan.getByText("Upfront paid-pilot conversion rate is at least 40 percent of usable offers",{exact:true})).toBeVisible();
    await expect(plan.getByText("Upfront paid-pilot conversion rate is below 1 percent of usable offers",{exact:true})).toBeVisible();
    await expect(plan.getByText(/1 to below 40 percent of usable offers/)).toBeVisible();
    expect(backend.fixtureCallCount()).toBe(3);
    await expect(page.getByRole("combobox",{name:"Experiment outcome",exact:true})).toHaveValue("not-run");
    await plan.getByRole("heading",{name:"Decision rules",exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:testInfo.outputPath("focused-valid.png")});
    await page.reload();
    await page.getByRole("button",{name:"Open thread Saved legacy experiment",exact:true}).click();
    await page.getByRole("button",{name:"Inspect the saved payment experiment",exact:true}).click();
    await expect(page.getByText(/Legacy numeric plan: metric bounds were not recorded/)).toBeVisible();
    await expect(page.getByText("Upfront paid-pilot conversion rate is below 0 percent of usable offers",{exact:true})).toBeVisible();
    expect(backend.fixtureCallCount()).toBe(3);
  } finally {await app.close();await backend.close();await app.cleanup();}
});
