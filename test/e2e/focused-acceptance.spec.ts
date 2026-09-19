import { expect, test } from "@playwright/test";
import { startFocusedAcceptanceBackend } from "./focused-acceptance-backend";
import { createInstalledApp } from "./installed-app";

test("installed UI rejects invalid planning, displays valid strict rules, and preserves a saved legacy plan",async({},testInfo)=>{
  const app=createInstalledApp({directoryPrefix:"scraply-focused-acceptance-"});
  const backend=await startFocusedAcceptanceBackend(app.directory);
  try {
    const electron=await app.launch({...process.env,SCRAPLY_E2E:"1",SCRAPLY_E2E_BACKEND_URL:backend.url,SCRAPLY_E2E_BACKEND_TOKEN:backend.token});
    const page=await electron.firstWindow();
    await page.getByRole("button",{name:"Inspect the saved payment experiment",exact:true}).click();
    await page.getByRole("button",{name:"Plan a focused experiment",exact:true}).click();
    await expect(page.getByText(/Numeric rules must allow both pass and fail/)).toBeVisible();
    expect(backend.workspace().solutions[0]?.focusedExperiment).toBeNull();
    expect(backend.fixtureCallCount()).toBe(1);
    await page.getByRole("button",{name:"Open thread Valid payment experiment",exact:true}).click();
    await page.getByRole("button",{name:"Inspect the saved payment experiment",exact:true}).click();
    await page.getByRole("button",{name:"Plan a focused experiment",exact:true}).click();
    const plan=page.getByRole("region",{name:"Focused experiment"});
    await expect(plan.getByText("Reviewed",{exact:true})).toBeVisible();
    await expect(plan.getByText("Upfront paid-pilot conversion rate is below 1 percent of usable offers",{exact:true})).toBeVisible();
    await expect(plan.getByText(/1 to below 40 percent of usable offers/)).toBeVisible();
    expect(backend.fixtureCallCount()).toBe(3);
    await page.screenshot({path:testInfo.outputPath("focused-valid.png")});
    await page.reload();
    await page.getByRole("button",{name:"Open thread Saved legacy experiment",exact:true}).click();
    await page.getByRole("button",{name:"Inspect the saved payment experiment",exact:true}).click();
    await expect(page.getByText(/Legacy numeric plan: metric bounds were not recorded/)).toBeVisible();
    await expect(page.getByText("Upfront paid-pilot conversion rate is below 0 percent of usable offers",{exact:true})).toBeVisible();
    expect(backend.fixtureCallCount()).toBe(3);
  } finally {await app.close();await backend.close();await app.cleanup();}
});
