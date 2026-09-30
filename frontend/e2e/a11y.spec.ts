import { test, expect } from "@playwright/test";
import { createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import AxeBuilder from "@axe-core/playwright";
import { WorkflowService } from "../src/gen/glyph/v1/workflow_pb";
import { CatalogService } from "../src/gen/glyph/v1/catalog_pb";

// Spec 0022: axe scans on the four audited views — Home, workspace Build,
// Definition mode and a run's Evidence view. Zero serious/critical violations.
let workflows: ReturnType<typeof createClient<typeof WorkflowService>>;
const backendUrl = process.env.E2E_BACKEND_URL ?? "http://localhost:3000";
test.beforeAll(() => {
  workflows = createClient(
    WorkflowService,
    createGrpcWebTransport({ baseUrl: backendUrl, useBinaryFormat: true }),
  );
});
test.beforeEach(async () => {
  await createClient(
    CatalogService,
    createGrpcWebTransport({ baseUrl: backendUrl, useBinaryFormat: true }),
  ).refreshModels({});
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
/** Fail on any serious or critical axe violation on the given page. */
async function expectNoSeriousViolations(page: import("@playwright/test").Page, view: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = results.violations.filter(
    (v) => ["serious", "critical"].includes(v.impact ?? ""),
  );
  for (const v of serious) {
    console.log(`axe ${v.id} (${v.impact}) on ${view}: ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  }
  expect(serious, `axe violations on ${view}`).toHaveLength(0);
}
test("Home is accessible", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("banner")).toBeVisible();
  await expectNoSeriousViolations(page, "Home");
});
test("workspace Build mode is accessible", async ({ page }) => {
  const id = await createWorkflow("E2E a11y canvas");
  await addStep(id, "Research", "notes", "Look things up.");
  await page.goto(`/workflows/${id}`);
  await expect(page.getByTestId("canvas")).toBeVisible();
  await expectNoSeriousViolations(page, "workspace Build");
});
test("Definition mode is accessible", async ({ page }) => {
  const id = await createWorkflow("E2E a11y definition");
  await addStep(id, "Research", "notes", "Look things up.");
  await page.goto(`/workflows/${id}/definition`);
  await expect(page.getByRole("textbox", { name: "YAML definition" })).toBeAttached();
  await expectNoSeriousViolations(page, "Definition mode");
});
test("a run's Evidence view is accessible", async ({ page }) => {
  const id = await createWorkflow("E2E a11y evidence");
  await addStep(id, "Greeter", "greeting", "Say hello.");
  await page.goto(`/workflows/${id}`);
  await page.getByRole("button", { name: "More workflow actions" }).click();
  await page.getByRole("menuitem", { name: "Test run" }).click();
  await page.getByRole("button", { name: "View run" }).click();
  await expect(page.getByTestId("run-header")).toContainText("Succeeded");
  // Open the step run panel: select the (only) step card on the lens canvas.
  const card = page.locator('[data-testid^="step-card-"]').first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("step-run-panel")).toBeVisible();
  await expectNoSeriousViolations(page, "run Evidence view");
});
