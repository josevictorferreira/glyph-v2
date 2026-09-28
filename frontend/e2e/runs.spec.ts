import { test, expect } from "@playwright/test";
import { createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { WorkflowService } from "../src/gen/glyph/v1/workflow_pb";
import { CatalogService } from "../src/gen/glyph/v1/catalog_pb";

// Spec 0020 e2e against the fake runner (GLYPH_STEP_RUNNER=fake): prompts
// carry FAKE_FAIL / FAKE_SLEEP:<ms> markers. Setup goes through the API;
// running and inspecting goes through the UI.

let workflows: ReturnType<typeof createClient<typeof WorkflowService>>;
const backendUrl = process.env.E2E_BACKEND_URL ?? "http://localhost:3000";

test.beforeAll(() => {
  const transport = createGrpcWebTransport({ baseUrl: backendUrl, useBinaryFormat: true });
  workflows = createClient(WorkflowService, transport);
});

test.beforeEach(async () => {
  const transport = createGrpcWebTransport({ baseUrl: backendUrl, useBinaryFormat: true });
  await createClient(CatalogService, transport).refreshModels({});
});

async function createWorkflow(name: string) {
  const id = (await workflows.createWorkflow({ name: `${name} ${Date.now()}` })).workflow?.summary
    ?.id;
  if (!id) throw new Error("createWorkflow returned no id");
  return id;
}

async function addStep(workflowId: string, name: string, outputName: string, prompt: string) {
  const stepId = (await workflows.addStep({ workflowId, kind: 1 })).newStepId;
  await workflows.updateStepDetails({ workflowId, stepId, name });
  await workflows.updateStepPrompt({ workflowId, stepId, prompt });
  await workflows.updateStepOutput({
    workflowId,
    stepId,
    outputName,
    expectedOutput: "Some text.",
  });
  await workflows.updateStepModel({ workflowId, stepId, modelId: "velox/glm-5-3" });
  return stepId;
}

async function connect(workflowId: string, sourceStepId: string, targetStepId: string) {
  await workflows.connectOutputToStep({ workflowId, sourceStepId, targetStepId });
}

test("starts a run with asked values and inspects the evidence", async ({ page }) => {
  const id = await createWorkflow("E2E run sheet");
  const topic = (
    await workflows.addWorkflowInput({
      workflowId: id,
      name: "topic",
      required: true,
      askAtRunTime: true,
    })
  ).newInputId;
  const step = await addStep(id, "Greeter", "greeting", "Say hello about {{topic}}.");
  const inputId = (
    await workflows.addStepInput({ workflowId: id, stepId: step, name: "subject", required: true })
  ).newInputId;
  await workflows.mapStepInput({ workflowId: id, inputId, workflowInputId: topic });
  await workflows.activateWorkflow({ id });

  await page.goto(`/workflows/${id}`);
  await page.getByTestId("run-now").click();
  const sheet = page.getByTestId("run-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("topic").fill("otters");
  await page.getByTestId("start-run").click();

  await expect(page).toHaveURL(new RegExp(`/workflows/${id}/runs/`));
  await expect(page.getByTestId("run-header")).toContainText("Succeeded");
  await page.getByTestId("step-card-" + (await snapshotStepId(page))).click();
  const panel = page.getByTestId("step-run-panel");
  await expect(panel.getByTestId("resolved-input-subject")).toContainText("otters");
  await expect(panel.getByTestId("step-output")).toContainText("Fake output from Greeter");
  await expect(page.getByText("Supplied values (1)")).toBeVisible();
});

/** The lens canvas uses snapshot step ids; read the only card's id from the DOM. */
async function snapshotStepId(page: import("@playwright/test").Page) {
  const card = page.locator('[data-testid^="step-card-"]').first();
  await expect(card).toBeVisible();
  return ((await card.getAttribute("data-testid")) ?? "").replace("step-card-", "");
}

test("stopping a running run cancels the queued downstream step", async ({ page }) => {
  const id = await createWorkflow("E2E stop");
  const slow = await addStep(id, "Slow", "notes", "Take your time. FAKE_SLEEP:20000");
  const next = await addStep(id, "Next", "summary", "Summarize.");
  await connect(id, slow, next);

  await page.goto(`/workflows/${id}`);
  await page.getByRole("button", { name: "More workflow actions" }).click();
  await page.getByRole("menuitem", { name: "Test run" }).click();
  await page.getByRole("button", { name: "View run" }).click();

  await expect(page.getByTestId("run-header")).toContainText("Running");
  await page.getByTestId("stop-run").click();
  await expect(page.getByTestId("run-header")).toContainText("Cancelled");
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page.getByRole("button", { name: /^Next: (Cancelled|Skipped)$/ })).toBeVisible();
});

test("a failed run opens on the failing step from Home, and retry re-runs it", async ({ page }) => {
  const id = await createWorkflow("E2E failure");
  await addStep(id, "Research", "notes", "Look it up. FAKE_FAIL");
  await workflows.activateWorkflow({ id });

  await page.goto(`/workflows/${id}`);
  await page.getByTestId("run-now").click();
  await page.getByRole("button", { name: "View run" }).click();
  await expect(page.getByTestId("run-header")).toContainText("Failed");

  // One click from Home lands on the failing step's error. Earlier suite
  // runs may have left other failed "E2E failure" workflows in this database.
  await page.goto("/");
  const card = page
    .getByTestId("home-attention-card")
    .filter({ hasText: "E2E failure" })
    .first();
  await card.getByRole("link", { name: /View run/ }).click();
  const error = page.getByTestId("step-run-error");
  await expect(error).toContainText("The selected model or provider could not complete the step.");

  await error.getByRole("button", { name: "Retry step" }).click();
  // The fake runner fails deterministically: the retried step fails again.
  await expect(page.getByTestId("run-header")).toContainText("Failed");
  await expect(page.getByTestId("step-run-error")).toBeVisible();
});

test("deleting a run updates the run strip live", async ({ page }) => {
  const id = await createWorkflow("E2E delete");
  await addStep(id, "Greeter", "greeting", "Say hello.");

  await page.goto(`/workflows/${id}/runs`);
  await expect(page.getByText("No runs yet").first()).toBeVisible();
  await page.getByTestId("runs-empty-run-now").click();
  await expect(page.getByTestId("run-chip")).toHaveCount(1);
  await expect(page.getByTestId("run-row")).toHaveCount(1);

  await page.getByTestId("run-row").getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("run-chip")).toHaveCount(0);
});

test("editing the workflow after a run does not change its evidence", async ({ page }) => {
  const id = await createWorkflow("E2E immutable");
  const step = await addStep(id, "Greeter", "greeting", "Original prompt.");

  await page.goto(`/workflows/${id}`);
  await page.getByRole("button", { name: "More workflow actions" }).click();
  await page.getByRole("menuitem", { name: "Test run" }).click();
  await page.getByRole("button", { name: "View run" }).click();
  await expect(page.getByTestId("run-header")).toContainText("Succeeded");
  const lensUrl = page.url();

  await workflows.updateStepPrompt({ workflowId: id, stepId: step, prompt: "Edited prompt." });
  await page.goto(lensUrl);
  await page.getByTestId("step-card-" + (await snapshotStepId(page))).click();
  await page.getByTestId("section-configuration").locator("summary").click();
  await expect(page.getByTestId("configuration-used")).toContainText("Original prompt.");
  await expect(page.getByTestId("configuration-used")).not.toContainText("Edited prompt.");
  await expect(page.getByTestId("snapshot-note")).toContainText(
    "This run used an earlier version of the workflow.",
  );
});
