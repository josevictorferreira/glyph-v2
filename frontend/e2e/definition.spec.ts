import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { WorkflowService } from "../src/gen/glyph/v1/workflow_pb";

// Spec 0021 e2e: definition mode. Dry-run problems on the right line, apply
// (round trip and edit → Build reflects it), the conflict path with all three
// resolutions, and the import acceptance round trip from the Rails seed YAML.

let workflows: ReturnType<typeof createClient<typeof WorkflowService>>;
const backendUrl = process.env.E2E_BACKEND_URL ?? "http://localhost:3000";

test.beforeAll(() => {
  const transport = createGrpcWebTransport({ baseUrl: backendUrl, useBinaryFormat: true });
  workflows = createClient(WorkflowService, transport);
});

async function createWorkflow(name: string) {
  const id = (await workflows.createWorkflow({ name: `${name} ${Date.now()}` })).workflow?.summary
    ?.id;
  if (!id) throw new Error("createWorkflow returned no id");
  return id;
}

async function addStep(workflowId: string, name: string) {
  const stepId = (await workflows.addStep({ workflowId, kind: 1 })).newStepId;
  await workflows.updateStepDetails({ workflowId, stepId, name });
  await workflows.updateStepPrompt({ workflowId, stepId, prompt: "Original prompt." });
  await workflows.updateStepModel({ workflowId, stepId, modelId: "velox/glm-5-3" });
  return stepId;
}

/** The editor's full text, via the download button (the DOM renders only the
 * visible lines). */
async function downloadYaml(page: import("@playwright/test").Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("download-yml").click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error("download produced no file");
  return readFileSync(path, "utf8");
}

/** Replace the whole editor content (Monaco: focus the hidden textarea,
 * select all, insert — Ctrl+A only selects when that textarea is focused). */
async function setYaml(page: import("@playwright/test").Page, yaml: string) {
  await page.getByRole("textbox", { name: "YAML definition" }).focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(yaml);
}

async function openDefinition(page: import("@playwright/test").Page, id: string) {
  await page.goto(`/workflows/${id}/definition`);
  await expect(page.getByTestId("definition-dirty")).toHaveText("Clean");
  await expect(page.getByRole("textbox", { name: "YAML definition" })).toBeAttached();
}

test("dry run marks unknown keys on the right line; applying a valid edit reaches Build", async ({
  page,
}) => {
  const id = await createWorkflow("E2E definition");
  await addStep(id, "Greeter");

  await openDefinition(page, id);
  const yaml = await downloadYaml(page);
  expect(yaml).toContain("name: E2E definition");
  expect(yaml).toContain("prompt: Original prompt.");

  // Unknown key inside a step → problem carrying its line.
  await setYaml(page, yaml.replace("name: Greeter", "name: Greeter\n  bogus: 1"));
  await expect(page.getByTestId("definition-dirty")).toHaveText("Edited");
  await expect(page.getByTestId("definition-problem")).toContainText(
    /Line \d+: "bogus" is not a known key here\./,
  );

  // Fix the document: edit the prompt and apply.
  await setYaml(page, yaml.replace("Original prompt.", "Prompt from YAML."));
  await page.getByTestId("apply-changes").click();
  await expect(page.getByText("Applied", { exact: true })).toBeVisible();
  await expect(page.getByTestId("definition-dirty")).toHaveText("Clean");

  await page.getByRole("link", { name: "Build", exact: true }).click();
  await page.locator('[data-testid^="step-card-"]').first().click();
  await expect(page.getByRole("combobox", { name: "Prompt", exact: true })).toHaveValue(
    "Prompt from YAML.",
  );
});

test("applying an unchanged export is a no-op round trip", async ({ page }) => {
  const id = await createWorkflow("E2E definition roundtrip");
  await addStep(id, "Greeter"); // a step-less export has `steps: []`, which the
  // schema rejects (minItems 1) — same as Rails.
  await openDefinition(page, id);
  const yaml = await downloadYaml(page);

  await setYaml(page, yaml); // identical text, still counts as clean
  await page.getByTestId("apply-changes").click();
  await expect(page.getByText("Applied", { exact: true })).toBeVisible();
  await expect(page.getByTestId("definition-dirty")).toHaveText("Clean");
  expect(page.getByTestId("definition-conflict")).toHaveCount(0);
  await expect(await downloadYaml(page)).toBe(yaml);
});

test("a concurrent edit warns while dirty; Discard adopts the server version", async ({
  browser,
}) => {
  const page = await browser.newPage();
  const page2 = await browser.newPage();
  const id = await createWorkflow("E2E definition conflict");
  await addStep(id, "Greeter");
  await openDefinition(page, id);
  const yaml = await downloadYaml(page);

  // Dirty this tab, then rename in the other tab.
  await setYaml(page, yaml.replace("Original prompt.", "My prompt."));
  await page2.goto(`/workflows/${id}`);
  const name2 = page2.getByTestId("workflow-name");
  await name2.fill("E2E definition conflict renamed");
  await name2.blur();

  await expect(page.getByTestId("definition-changed-elsewhere")).toBeVisible();
  await expect(page.getByText("This workflow changed elsewhere.")).toBeVisible();

  await page.getByTestId("definition-review").click();
  await expect(page.getByTestId("definition-conflict")).toBeVisible();
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();

  await page.getByTestId("conflict-discard").click();
  await expect(page.getByTestId("definition-conflict")).toHaveCount(0);
  await expect(page.getByTestId("definition-dirty")).toHaveText("Clean");
  await expect(await downloadYaml(page)).toContain("E2E definition conflict renamed");
});

test("a stale apply opens the conflict; Keep editing then Overwrite wins", async ({ browser }) => {
  const page = await browser.newPage();
  const page2 = await browser.newPage();
  const id = await createWorkflow("E2E definition overwrite");
  await addStep(id, "Greeter");
  await openDefinition(page, id);
  const yaml = await downloadYaml(page);
  await setYaml(page, yaml.replace("Original prompt.", "My prompt."));

  // Rename elsewhere; our fingerprint is now stale.
  await page2.goto(`/workflows/${id}`);
  const name2 = page2.getByTestId("workflow-name");
  await name2.fill("E2E definition overwrite renamed");
  await name2.blur();

  // Apply directly: ABORTED → conflict view.
  await page.getByTestId("apply-changes").click();
  await expect(page.getByTestId("definition-conflict")).toBeVisible();

  // Keep my text on top of latest and apply: no second conflict, it lands.
  await page.getByTestId("conflict-keep-mine").click();
  await expect(page.getByTestId("definition-conflict")).toHaveCount(0);
  await expect(page.getByTestId("definition-dirty")).toHaveText("Edited");
  await page.getByTestId("apply-changes").click();
  await expect(page.getByText("Applied", { exact: true })).toBeVisible();
  await expect(page.getByTestId("definition-conflict")).toHaveCount(0);
  await expect(page.getByTestId("definition-dirty")).toHaveText("Clean");

  // Another foreign change — this time overwrite the latest version.
  const mine = await downloadYaml(page);
  await setYaml(page, mine.replace("My prompt.", "My prompt, again."));
  await expect(page.getByTestId("definition-dirty")).toHaveText("Edited");
  const name2b = page2.getByTestId("workflow-name");
  await name2b.fill("E2E definition overwrite renamed again");
  await name2b.blur();
  // The banner proves our fingerprint went stale; only then is the apply
  // guaranteed to abort into the conflict view.
  await expect(page.getByTestId("definition-changed-elsewhere")).toBeVisible();
  await page.getByTestId("apply-changes").click();
  await expect(page.getByTestId("definition-conflict")).toBeVisible();
  await page.getByTestId("conflict-overwrite").click();
  await expect(page.getByTestId("overwrite-dialog")).toBeVisible();
  await page.getByTestId("overwrite-confirm").click();
  await expect(page.getByTestId("definition-conflict")).toHaveCount(0);

  // My text won: the name from my (older) document is back.
  await page.getByRole("link", { name: "Build", exact: true }).click();
  await expect(page.getByTestId("workflow-name")).toHaveValue(/E2E definition overwrite \d+/);
});

test("the Rails seed YAML imports through the dialog", async ({ page }) => {
  const seedPath = `${process.cwd()}/../backend/seeds/design_poc_tournament.yml`;
  const yaml = readFileSync(seedPath, "utf8");

  await page.goto("/");
  await page.getByTestId("library-new").click();
  await page.getByRole("tab", { name: "From YAML" }).click();
  await page.getByRole("textbox", { name: "YAML definition" }).focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(yaml);
  await expect(page.getByTestId("yaml-valid")).toBeVisible();
  await page.getByTestId("import-submit").click();

  await expect(page.getByTestId("workflow-name")).toHaveValue("Design POC Tournament");
});
