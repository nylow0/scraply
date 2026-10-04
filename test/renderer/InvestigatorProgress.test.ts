import { render, within } from "@testing-library/svelte";
import { describe, expect, test } from "vitest";
import InvestigatorProgress from "../../src/renderer/components/InvestigatorProgress.svelte";
import type { InvestigatorLane } from "../../src/renderer/lib/investigator-progress";

const investigators: InvestigatorLane[] = [
  { areaId: "bank", areaName: "Bank matching", state: "running", currentStep: "Checking a second independent account", confirmedCount: 1, insufficientCount: 2, droppedCount: 0 },
  { areaId: "documents", areaName: "Client documents", state: "ready", currentStep: null, confirmedCount: null, insufficientCount: null, droppedCount: null },
];

describe("InvestigatorProgress", () => {
  test("shows each area's own saved decisions and current step without a progress percentage", () => {
    const view = render(InvestigatorProgress, { investigators });
    const bank = within(view.getByRole("listitem", { name: "Bank matching investigator" }));
    expect(bank.getByRole("heading", { name: "Bank matching" })).toBeTruthy();
    expect(bank.getByText("Running")).toBeTruthy();
    expect(bank.getByText(/Checking a second independent account/)).toBeTruthy();
    expect(bank.getByText("Problems").nextElementSibling?.textContent).toBe("1");
    expect(bank.getByText("Needs more evidence").nextElementSibling?.textContent).toBe("2");
    expect(bank.getByText("Ruled out").nextElementSibling?.textContent).toBe("0");
    const documents = within(view.getByRole("listitem", { name: "Client documents investigator" }));
    expect(documents.getByText("Queued")).toBeTruthy();
    expect(documents.getAllByText("Unknown")).toHaveLength(3);
    expect(documents.getByText(/No step recorded/)).toBeTruthy();
    expect(view.queryByRole("progressbar")).toBeNull();
  });

  test("updates the correct lane as evidence checks finish while retaining other areas", async () => {
    const view = render(InvestigatorProgress, { investigators });
    await view.rerender({ investigators: [
      { ...investigators[0]!, state: "succeeded", currentStep: "Evidence checks finished", confirmedCount: 2, insufficientCount: 0, droppedCount: 1 },
      { ...investigators[1]!, state: "running", currentStep: "Reading firsthand sources", confirmedCount: 0, insufficientCount: 1, droppedCount: 0 },
    ] });
    const bank = within(view.getByRole("listitem", { name: "Bank matching investigator" }));
    expect(bank.getByText("Finished")).toBeTruthy();
    expect(bank.getByText(/Evidence checks finished/)).toBeTruthy();
    expect(bank.getByText("Problems").nextElementSibling?.textContent).toBe("2");
    expect(bank.getByText("Needs more evidence").nextElementSibling?.textContent).toBe("0");
    expect(bank.getByText("Ruled out").nextElementSibling?.textContent).toBe("1");
    const documents = within(view.getByRole("listitem", { name: "Client documents investigator" }));
    expect(documents.getByText("Running")).toBeTruthy();
    expect(documents.getByText(/Reading firsthand sources/)).toBeTruthy();
    expect(documents.getByText("Needs more evidence").nextElementSibling?.textContent).toBe("1");
  });

  test("labels a lost completion honestly and preserves already saved counts", () => {
    const view = render(InvestigatorProgress, { investigators: [{
      ...investigators[0]!, state: "unknown", currentStep: "Waiting for a verdict result", confirmedCount: 1,
    }] });
    expect(view.getByText("Completion unknown")).toBeTruthy();
    expect(view.getByText("Problems").nextElementSibling?.textContent).toBe("1");
    expect(view.queryByText("Finished")).toBeNull();
  });

  test("leaves old runs without investigator work unchanged", () => {
    const view = render(InvestigatorProgress, { investigators: [] });
    expect(view.queryByRole("region", { name: "Area investigators" })).toBeNull();
    expect(view.queryByRole("list")).toBeNull();
  });
});
