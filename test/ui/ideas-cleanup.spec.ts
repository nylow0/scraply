import { expect, test, type Page } from "@playwright/test";
import { EXPLAIN_IDEA_PROMPT } from "../../src/renderer/lib/idea-content";

async function openConversation(page: Page, query = "") {
  await page.goto(`/?slice2=1&history=1${query}`);
  await page.getByRole("button", { name: "Open idea: History access and provenance pack" }).click();
  await page.getByRole("button", { name: "Explore this idea" }).click();
  await expect(page.getByRole("heading", { name: "Conversation", exact: true })).toBeVisible();
}

test("numbered ideas retain both saved formats and open with accessible Back and Escape", async ({ page }) => {
  await page.goto("/?slice2=1&history=1");
  const groups = page.locator(".problem-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0).locator(".idea-number")).toHaveText(["1.", "2.", "3.", "4.", "5.", "6.", "7.", "8."]);
  await expect(groups.nth(1).locator(".idea-number")).toHaveText(["1.", "2.", "3."]);
  const old = page.getByRole("button", { name: "Open idea: History access and provenance pack" });
  await expect(old.locator(".idea-summary")).toContainText("A programming-project workflow improvement");
  const recent = page.getByRole("button", { name: "Open idea: Weekend energy log" });
  await expect(recent.locator(".idea-summary")).toContainText("Caretakers note what was left on each Friday.");
  await old.click();
  await expect(page.getByRole("heading", { name: "History access and provenance pack", exact: true })).toBeVisible();
  await expect(page.locator(".idea-detail .mechanism li")).toHaveCount(9);
  await expect(page.getByRole("button", { name: "Choose and analyze" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(old).toBeFocused();
});

test("Explain submits its hidden fixed text using the selected model and effort", async ({ page }) => {
  await openConversation(page);
  await page.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: "GPT-6 Astra", exact: true }).click();
  await page.getByRole("combobox", { name: "Effort" }).selectOption("high");
  await page.getByRole("button", { name: "Explain", exact: true }).click();
  await expect(page.locator(".message.user")).toHaveText("Explain this idea");
  await expect(page.locator(".message.assistant")).toContainText("This is a shared evidence pack");
  const turn = await page.evaluate(() => (window as unknown as { scraplyFixture: { turns: Array<{ text: string; intent: string; model: { modelId: string }; reasoningEffort: string }> } }).scraplyFixture.turns[0]);
  expect(turn).toMatchObject({ intent: "explain", text: EXPLAIN_IDEA_PROMPT, model: { modelId: "gpt-6-astra" }, reasoningEffort: "high" });
  await expect(page.getByText(EXPLAIN_IDEA_PROMPT, { exact: true })).toHaveCount(0);
  await page.getByText("Assumptions", { exact: true }).click();
  await expect(page.getByText("The school approves sharing the export.", { exact: true })).toBeVisible();
});

for (const legacy of [false, true]) {
  test(`analysis runs and stops in the conversation without losing its draft, legacy=${legacy}`, async ({ page }) => {
    await openConversation(page, legacy ? "&legacy=1" : "");
    const input = page.getByRole("textbox", { name: "Follow-up message" });
    await input.fill("Keep this draft while reviewing risks.");
    await page.getByRole("button", { name: "Analyze risks", exact: true }).click();
    const progress = page.getByRole("region", { name: "Idea conversation" }).getByRole("status", { name: "Active idea work" });
    await expect(progress).toContainText("Reviewing risks");
    await expect(progress.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
    await expect(input).toBeDisabled();
    await expect(page.getByRole("button", { name: "Running & attention 1" })).toBeVisible();
    await progress.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Conversation", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Analyze risks", exact: true })).toBeEnabled();
    await expect(input).toHaveValue("Keep this draft while reviewing risks.");
    await expect(page.getByRole("button", { name: "Running & attention 1" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  });
  for (const destination of ["list", "idea"] as const) {
    test(`Stop on the ${destination} preserves its screen, legacy=${legacy}`, async ({ page }) => {
      await openConversation(page, legacy ? "&legacy=1" : "");
      await page.getByRole("button", { name: "Analyze risks", exact: true }).click();
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Back to idea" }).click();
      if (destination === "list") await page.getByRole("button", { name: "Back to ideas" }).click();
      const screen = destination === "list" ? page.getByRole("heading", { name: "11 ideas" }) : page.getByRole("heading", { name: "History access and provenance pack", exact: true });
      await expect(screen).toBeVisible();
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(screen).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      if (destination === "list") await page.getByRole("button", { name: "Open idea: History access and provenance pack" }).click();
      await page.getByRole("button", { name: "Explore this idea" }).click();
      await expect(page.getByRole("button", { name: "Analyze risks", exact: true })).toBeEnabled();
    });
  }
}

test("a failed analysis shows an explicit Retry and a completed analysis stays on the conversation", async ({ page }) => {
  await openConversation(page);
  await page.getByRole("button", { name: "Analyze risks", exact: true }).click();
  await page.evaluate(() => (window as unknown as { scraplyFixture: { failAnalysis(): void } }).scraplyFixture.failAnalysis());
  const failure = page.locator(".analysis-error");
  await expect(failure).toContainText("The risk evaluator could not complete its reply.");
  await expect(failure.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Running & attention 1" })).toHaveCount(0);
  await failure.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { scraplyFixture: { finishAnalysis(): void } }).scraplyFixture.finishAnalysis());
  await expect(page.getByRole("heading", { name: "Risk analysis", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Analyze risks", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Conversation", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to idea" }).click();
  await expect(page.locator(".idea-detail").getByText("Next experiment", { exact: true })).toBeVisible();
});

test("version history and narrow tabs keep names and real changes", async ({ page }) => {
  await openConversation(page, "&versions=3&turns=many");
  await expect(page.locator(".versions li")).toHaveCount(3);
  await expect(page.locator(".change-summary")).toHaveCount(1);
  await page.getByText("Compare with v1", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "How it worked before" })).toBeVisible();
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.getByRole("tab", { name: "Conversation", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Idea", exact: true }).click();
  await expect(page.getByRole("heading", { name: "School evidence pack 2", exact: true })).toBeVisible();
});

test("optional idea sections, legacy bodies, short returns and the grouping review remain readable", async ({ page }) => {
  for (const query of ["&minimal=1", "&unranked=1&grouping=1", "&mode=controlled", "&purpose=known-problem", "&saved=v1"]) {
    await page.goto(`/?slice2=1&history=1${query}`);
    if (query.includes("grouping")) {
      await expect(page.getByText(/Review idea grouping/)).toBeVisible();
      await page.getByText(/Review idea grouping/).click();
      await expect(page.getByRole("button", { name: "Review 11 saved ideas" })).toBeVisible();
      for (const caption of ["Business grouping", "Add a reason to enable manual decisions. Scraply saves it with each change.", "Enter a reason above to enable these decisions."]) await expect(page.getByText(caption, { exact: true })).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Open idea: History access and provenance pack" }).click();
    await expect(page.getByRole("heading", { name: "History access and provenance pack", exact: true })).toBeVisible();
    if (query.includes("minimal")) {
      for (const section of ["First test", "Startup opportunity", "Wider problem"]) await expect(page.getByText(section, { exact: true })).toHaveCount(0);
    } else if (!query.includes("saved=v1")) {
      await page.getByText("Startup opportunity", { exact: true }).click();
      await expect(page.getByText("Paying customer", { exact: true })).toBeVisible();
      await page.getByText("First test", { exact: true }).click();
      await expect(page.getByText("Sample and duration", { exact: true })).toBeVisible();
      await page.getByText("Problem and fit", { exact: true }).click();
      await expect(page.getByText("Wider problem", { exact: true })).toBeVisible();
      if (query.includes("unranked")) await expect(page.getByText("Why it ranks here", { exact: true })).toHaveCount(0);
      else await expect(page.getByText("Why it ranks here", { exact: true })).toBeVisible();
    }
    if (query.includes("saved=v1")) {
      await expect(page.getByRole("button", { name: "Explore this idea" })).toHaveCount(0);
      await page.getByText("Evidence behind this problem", { exact: true }).click();
      await expect(page.getByText("School operations interview", { exact: true })).toBeVisible();
    }
  }
  await page.goto("/?ideas=short&history=1");
  await expect(page.getByText("2 of 3 ideas returned", { exact: true })).toBeVisible();
});

test("browser history restores nested views, list scroll, Settings, projects and the hidden draft", async ({ page }) => {
  await page.goto("/?slice2=1&history=2");
  const listRow = page.getByRole("button", { name: "Open idea: History access and provenance pack" });
  await expect(listRow).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map(animation => animation.finished));
  });
  await page.locator(".main-content").evaluate(el => { el.scrollTop = 150; });
  const scrollTop = await page.locator(".main-content").evaluate(el => el.scrollTop);
  expect(scrollTop).toBeGreaterThan(100);
  await listRow.click();
  await expect(page.getByRole("button", { name: "Go back" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Go forward" })).toBeDisabled();
  await page.getByRole("button", { name: "Explore this idea" }).click();
  await expect(page.getByRole("heading", { name: "Conversation", exact: true })).toBeVisible();
  await page.getByLabel("Follow-up message").fill("Retain this unsent conversation.");
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByRole("button", { name: "Explore this idea" })).toBeVisible();
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(listRow).toBeVisible();
  await expect.poll(() => page.locator(".main-content").evaluate(el => el.scrollTop)).toBe(scrollTop);
  await page.getByRole("button", { name: "Go forward" }).click();
  await expect(page.getByRole("button", { name: "Explore this idea" })).toBeVisible();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByLabel("Follow-up message")).toHaveValue("Retain this unsent conversation.");
  await page.getByRole("button", { name: "Back to idea" }).click();
  await page.getByRole("button", { name: "Go forward" }).click();
  await expect(page.getByLabel("Follow-up message")).toHaveValue("Retain this unsent conversation.");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Explore this idea" })).toBeVisible();
  await page.getByRole("button", { name: /^Open thread / }).nth(1).click();
  await expect(page.getByRole("button", { name: "Explore this idea" })).toHaveCount(0);
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByRole("button", { name: "Explore this idea" })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("region", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Go back" }).click();
  await expect(page.getByRole("region", { name: "Settings", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Explore this idea" })).toBeVisible();
  await page.getByRole("button", { name: "Go forward" }).click();
  await expect(page.getByRole("region", { name: "Settings", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Create new research thread" }).click();
  await page.getByPlaceholder("Your topic or idea").fill("Draft that survives history");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByRole("button", { name: "Explore this idea" })).toBeVisible();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByPlaceholder("Your topic or idea")).toHaveValue("Draft that survives history");
});
