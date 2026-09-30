import { test, expect } from "@playwright/test";
import { createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { WorkflowService } from "../src/gen/glyph/v1/workflow_pb";
import { CatalogService } from "../src/gen/glyph/v1/catalog_pb";

// UX-audit fixes (2026-09-30): ticket 5 — the YAML editor mounts without
// worker rejections and schema squiggles still work; ticket 3 — a recovered
// needs_attention workflow shows one consistent state with a Reactivate
// action instead of contradicting "Needs attention" + "Ready" badges.
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

async function createWorkflow(name: string) {
  const created = await workflows.createWorkflow({ name });
  const id = created.workflow?.summary?.id;
  if (!id) throw new Error("createWorkflow returned no id");
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

test("ticket 5: the YAML editor is error-free and schema validation works", async ({ page }) => {
  const errors: string[] = [];
  const noise = (t: string) =>
    t.includes("favicon") || (t.includes("Failed to load resource") && t.includes("404"));
  page.on("console", (m) => {
    if (m.type() === "error" && !noise(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => {
    const msg = String((e as Error).message ?? e);
    if (!noise(msg)) errors.push(msg);
  });
  const id = await createWorkflow(`E2E yaml worker ${Date.now()}`);
  await page.goto(`/workflows/${id}/definition`);
  await page.getByRole("textbox", { name: "YAML definition" }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(6_000);
  // Schema validation through the live worker: type an invalid steps list and
  // expect squiggles (the worker answered doValidation).
  await page.locator(".monaco-editor").first().click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.type("steps: [1, 2, 3]\n");
  await page.waitForTimeout(3_500);
  const squiggles = await page.locator(
    ".monaco-editor .squiggly-error, .monaco-editor .squiggly-warning",
  );
  await expect(squiggles.first()).toBeVisible();
  expect(errors, `console/page errors: ${errors.join(" || ")}`).toHaveLength(0);
});

test("ticket 3: a recovered workflow offers Reactivate instead of contradicting badges", async ({
  page,
}) => {
  const id = await createWorkflow(`E2E reactivate ${Date.now()}`);
  const inputId = (
    await workflows.addWorkflowInput({
      workflowId: id,
      name: "brief",
      required: true,
      askAtRunTime: true,
    })
  ).newInputId;
  await workflows.activateWorkflow({ id });
  // A schedule with a stored value keeps the workflow valid…
  await workflows.saveSchedule({
    workflowId: id,
    recurrence: { case: "weekly", value: { weekday: 1, hour: 9, minute: 0 } },
    timezone: "UTC",
    enabled: true,
  });
  await workflows.setScheduleValue({ workflowId: id, workflowInputId: inputId, value: "pitch" });
  await page.goto(`/workflows/${id}`);
  await page.getByTestId("workspace-header").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);

  // …removing it moves the workflow to needs_attention with zero issues.
  await workflows.saveSchedule({
    workflowId: id,
    recurrence: { case: "none", value: {} },
    timezone: "UTC",
    enabled: false,
  });
  await page.reload();
  await page.getByTestId("workspace-header").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);

  const pill = (await page.getByTestId("readiness-pill").innerText()).trim();
  expect(pill).toContain("reactivate");
  expect(pill.toLowerCase()).not.toBe("ready");

  await page.getByTestId("reactivate").click();
  await page.waitForTimeout(1_200);
  const after = await page.getByTestId("workspace-header").innerText();
  await expect
    .poll(async () => (await page.getByTestId("workspace-header").innerText()).includes("Active"))
    .toBeTruthy();
  expect(after).not.toContain("Needs attention");
});
