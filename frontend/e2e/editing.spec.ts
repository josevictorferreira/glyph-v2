import { test, expect } from "@playwright/test";
import { createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { WorkflowService } from "../src/gen/glyph/v1/workflow_pb";
import { CatalogService } from "../src/gen/glyph/v1/catalog_pb";

// Spec 0018 e2e: connect two steps from the source picker (task 4), define
// workflow values and map one to a step input (task 7), readiness deep link
// focuses the prompt (task 8), and draft → blocked → fix → activate → pause
// → resume (task 9). Setup goes through the API; the behaviour under test
// goes through the UI.

let workflows: ReturnType<typeof createClient<typeof WorkflowService>>;
let catalog: ReturnType<typeof createClient<typeof CatalogService>>;

const backendUrl = process.env.E2E_BACKEND_URL ?? "http://localhost:3000";

test.beforeAll(() => {
  const transport = createGrpcWebTransport({ baseUrl: backendUrl, useBinaryFormat: true });
  workflows = createClient(WorkflowService, transport);
  catalog = createClient(CatalogService, transport);
});

test.beforeEach(async () => {
  await catalog.refreshModels({});
});

async function createWorkflow(name: string) {
  const id = (await workflows.createWorkflow({ name })).workflow?.summary?.id;
  if (!id) throw new Error(`createWorkflow(${name}) returned no id`);
  return id;
}

/** A Pi step with everything but the prompt (so readiness has exactly one issue for it). */
async function addStep(workflowId: string, name: string, outputName: string, prompt?: string) {
  const stepId = (await workflows.addStep({ workflowId, kind: 1 })).newStepId;
  await workflows.updateStepDetails({ workflowId, stepId, name });
  if (prompt) await workflows.updateStepPrompt({ workflowId, stepId, prompt });
  await workflows.updateStepOutput({
    workflowId,
    stepId,
    outputName,
    expectedOutput: "Some text.",
  });
  await workflows.updateStepModel({ workflowId, stepId, modelId: "velox/glm-5-3" });
  return stepId;
}

test("connects two steps purely from the source picker", async ({ page }) => {
  const id = await createWorkflow("E2E source picker");
  await addStep(id, "Research", "notes", "Research the topic.");
  const writer = await addStep(id, "Writer", "draft", "Write it up.");

  await page.goto(`/workflows/${id}?step=${writer}`);
  await page.getByRole("tab", { name: "Inputs" }).click();
  await page.getByLabel("New input name").fill("notes");
  await page.getByRole("button", { name: "Add input" }).click();
  await page.getByRole("button", { name: "Source for notes" }).click();
  await page.getByRole("option", { name: /Output of Research/ }).click();

  await expect(page.getByRole("button", { name: "Source for notes" })).toHaveText(
    /Output of Research/,
  );
  const wf = (await workflows.getWorkflow({ id })).workflow!;
  expect(wf.connections).toHaveLength(1);
  expect(wf.connections[0]!.destinationStepId).toBe(writer);
});

test("adds a constant and an asked value and maps one to a step input", async ({ page }) => {
  const id = await createWorkflow("E2E workflow values");
  const step = await addStep(id, "Writer", "draft", "Write about {{topic}}.");

  await page.goto(`/workflows/${id}`);
  await page.getByRole("button", { name: /Workflow values/ }).click();
  await page.getByLabel("New value name").fill("topic");
  await page.getByRole("button", { name: "Add value" }).click();
  await expect(page.getByTestId("workflow-value-topic")).toBeVisible();

  await page.getByLabel("New value name").fill("tone");
  await page.getByRole("combobox", { name: "New value kind" }).click();
  await page.getByRole("option", { name: "Constant" }).click();
  await page.getByLabel("New value", { exact: true }).fill("friendly");
  await page.getByRole("button", { name: "Add value" }).click();
  await expect(page.getByTestId("workflow-value-tone")).toBeVisible();

  await page.goto(`/workflows/${id}?step=${step}`);
  await page.getByRole("tab", { name: "Inputs" }).click();
  await page.getByLabel("New input name").fill("subject");
  await page.getByRole("button", { name: "Add input" }).click();
  await page.getByRole("button", { name: "Source for subject" }).click();
  await page.getByRole("option", { name: /Workflow value topic/ }).click();
  await expect(page.getByRole("button", { name: "Source for subject" })).toHaveText(
    /Workflow value topic/,
  );

  const wf = (await workflows.getWorkflow({ id })).workflow!;
  const topic = wf.inputs.find((i) => i.name === "topic")!;
  expect(topic.askAtRunTime).toBe(true);
  expect(wf.inputs.find((i) => i.name === "tone")).toMatchObject({
    askAtRunTime: false,
    value: "friendly",
  });
  expect(wf.steps[0]!.inputs.find((i) => i.name === "subject")?.workflowInputId).toBe(topic.id);
});

test("readiness deep link focuses the step's prompt", async ({ page }) => {
  const id = await createWorkflow("E2E readiness deep link");
  await addStep(id, "Summarizer", "summary");

  await page.goto(`/workflows/${id}`);
  await page.getByTestId("readiness-pill").click();
  await page.getByRole("button", { name: "“Summarizer” needs a prompt." }).click();
  await expect(page.getByRole("combobox", { name: "Prompt", exact: true })).toBeFocused();
});

test("draft → activate blocked → fix → activate → pause → resume", async ({ page }) => {
  const id = await createWorkflow("E2E lifecycle");
  const step = await addStep(id, "Greeter", "greeting");

  await page.goto(`/workflows/${id}?step=${step}`);
  await expect(page.getByTestId("activate")).toBeDisabled();

  const prompt = page.getByRole("combobox", { name: "Prompt", exact: true });
  await prompt.fill("Say hello.");
  await prompt.blur();
  await expect(page.getByTestId("activate")).toBeEnabled();

  await page.getByTestId("activate").click();
  await expect(page.getByTestId("run-now")).toBeVisible();

  await page.getByRole("button", { name: "More workflow actions" }).click();
  await page.getByRole("menuitem", { name: "Pause" }).click();
  await page.getByTestId("confirm-pause").click();
  await expect(page.getByTestId("resume")).toBeVisible();

  await page.getByTestId("resume").click();
  await expect(page.getByTestId("run-now")).toBeVisible();
});
