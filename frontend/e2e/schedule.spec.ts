import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { WorkflowService } from "../src/gen/glyph/v1/workflow_pb";
import { CatalogService } from "../src/gen/glyph/v1/catalog_pb";

// Spec 0019 e2e: a weekly schedule shows the next run on an active workflow,
// and a required asked input without a schedule value moves the workflow to
// needs_attention until the value is set and the workflow is reactivated.
//
// Activation requires a model, so the stack's model catalog is fed by the
// mock velox server from playwright.config.ts (webServer[0]); the refresh
// here makes it deterministic instead of waiting for the recurring job.

let transport: ReturnType<typeof createGrpcWebTransport>;
let workflows: ReturnType<typeof createClient<typeof WorkflowService>>;

const backendUrl = process.env.E2E_BACKEND_URL ?? "http://localhost:3000";

test.beforeAll(() => {
  transport = createGrpcWebTransport({ baseUrl: backendUrl, useBinaryFormat: true });
  workflows = createClient(WorkflowService, transport);
});

test.beforeEach(async () => {
  await createClient(CatalogService, transport).refreshModels({});
});

/** A minimal activatable workflow: one complete Pi step. */
async function createWorkflow(name: string) {
  const created = await workflows.createWorkflow({ name });
  const id = created.workflow?.summary?.id;
  if (!id) throw new Error(`createWorkflow(${name}) returned no id`);
  const stepId = (await workflows.addStep({ workflowId: id, kind: 1 })).newStepId;
  await workflows.updateStepDetails({ workflowId: id, stepId, name: "Greeter" });
  await workflows.updateStepPrompt({ workflowId: id, stepId, prompt: "Say hello." });
  await workflows.updateStepOutput({
    workflowId: id,
    stepId,
    outputName: "greeting",
    expectedOutput: "A one-line greeting.",
  });
  await workflows.updateStepModel({ workflowId: id, stepId, modelId: "velox/glm-5-3" });
  return id;
}

/** Open the editor with the workflow (not a step) selected, then the Schedule section. */
async function openSchedulePanel(page: Page, id: string) {
  await page.goto(`/workflows/${id}`);
  // exact: the header schedule chip's accessible name starts with "Schedule".
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
}

/** Weekly Monday 09:00 in the viewer timezone (pinned to UTC in playwright.config). */
async function saveWeeklySchedule(page: Page) {
  await page.getByRole("button", { name: "Add schedule" }).click();
  await page.getByRole("tab", { name: "Weekly" }).click();
  await page.locator("#schedule-time").fill("09:00");
  // Weekday defaults to Monday.
  await page.getByTestId("save-schedule").click();
}

test("weekly schedule on an active workflow shows the next run", async ({ page }) => {
  const id = await createWorkflow("E2E schedule next run");
  await workflows.activateWorkflow({ id });

  await openSchedulePanel(page, id);
  await saveWeeklySchedule(page);

  const card = page.getByTestId("schedule-active");
  await expect(card).toBeVisible();
  // Weekly Monday 09:00 always lands on a Mon.
  await expect(card).toContainText(/Next: Mon, .* 09:00/);
});

test("required asked input without a schedule value blocks until filled", async ({ page }) => {
  const id = await createWorkflow("E2E schedule missing value");
  await workflows.addWorkflowInput({
    workflowId: id,
    name: "topic",
    required: true,
    askAtRunTime: true,
  });
  await workflows.activateWorkflow({ id });

  await openSchedulePanel(page, id);
  await saveWeeklySchedule(page);

  // Saving an enabled schedule revalidates the active workflow → needs_attention.
  const card = page.getByTestId("schedule-attention");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Not dispatching: fix the issues first.");
  await expect(page.getByTestId("schedule-values")).toContainText(
    "The schedule needs a value for the required workflow input “topic”.",
  );

  // Fill the stored value (autosaves on blur) → the issue clears.
  const field = page.getByLabel("Value for scheduled runs: topic");
  await field.fill("Release notes");
  await field.blur();
  await expect(page.getByTestId("schedule-attention")).toHaveCount(0);

  // needs_attention never auto-heals: reactivate from the readiness sheet.
  await page.getByTestId("review-issues").click();
  await expect(page.getByTestId("readiness-sheet")).toContainText(
    "No issues. Everything is ready.",
  );
  await page.getByTestId("readiness-activate").click();
  await expect(page.getByTestId("schedule-active")).toContainText(/Next: Mon, .* 09:00/);
});
