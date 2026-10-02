import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { WorkflowService } from "../src/gen/glyph/v1/workflow_pb";
import { RunService } from "../src/gen/glyph/v1/run_pb";
import { CatalogService } from "../src/gen/glyph/v1/catalog_pb";

// Spec 0023 e2e: build the tournament by clicking — write one Generate
// prompt, "Make shared", duplicate the step three times and change the
// models on the copies; Definition mode shows a single shared text with four
// refs; a fake-runner run executes the rendered text in every step run.

let workflows: ReturnType<typeof createClient<typeof WorkflowService>>;
let runs: ReturnType<typeof createClient<typeof RunService>>;
let catalog: ReturnType<typeof createClient<typeof CatalogService>>;
const backendUrl = process.env.E2E_BACKEND_URL ?? "http://localhost:3000";

test.beforeAll(() => {
  const transport = createGrpcWebTransport({ baseUrl: backendUrl, useBinaryFormat: true });
  workflows = createClient(WorkflowService, transport);
  runs = createClient(RunService, transport);
  catalog = createClient(CatalogService, transport);
});

test.beforeEach(async () => {
  await catalog.refreshModels({});
});

/** The prompt every Generate step shares. */
const PROMPT =
  "You are a distinguished product designer. Produce one landing page concept for the brief.";
const EXPECTED = "One landing page concept.";

async function currentWorkflow(id: string) {
  return (await workflows.getWorkflow({ id })).workflow!;
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

async function pickModel(page: import("@playwright/test").Page, modelId: string) {
  await page.getByRole("button", { name: "Model" }).click();
  await page.getByRole("option", { name: modelId, exact: true }).click();
}

test("builds a tournament from one shared prompt and runs it", async ({ page }) => {
  test.setTimeout(90_000);

  // Create the workflow through the dialog.
  await page.goto("/");
  await page.getByTestId("library-new").click();
  await page.getByTestId("create-name").fill("E2E shared texts");
  await page.getByTestId("create-submit").click();
  await page.waitForURL(/\/workflows\/[^/]+$/);
  const id = page.url().match(/workflows\/([^/?#]+)/)![1]!;

  // One Generate step with the participant prompt.
  await page.getByTestId("canvas-add-step").click();
  await page.getByRole("menuitem", { name: "Add Pi step" }).click();
  const name = page.getByTestId("step-name");
  await name.fill("Generate — GLM 5.3");
  await name.blur();
  await expect
    .poll(async () => (await currentWorkflow(id)).steps[0]?.name)
    .toBe("Generate — GLM 5.3");

  const prompt = page.getByRole("combobox", { name: "Prompt", exact: true });
  await prompt.fill(PROMPT);
  await prompt.blur();
  await expect.poll(async () => (await currentWorkflow(id)).steps[0]?.prompt).toBe(PROMPT);

  // "Make shared" pre-fills the key from the step name; name it designer_brief.
  await page.getByTestId("make-shared").click();
  await expect(page.getByTestId("make-shared-key")).toHaveValue("generate_glm_5_3_prompt");
  await page.getByTestId("make-shared-key").fill("designer_brief");
  await page.getByTestId("make-shared-confirm").click();
  await expect
    .poll(async () => {
      const wf = await currentWorkflow(id);
      return wf.texts[0]?.key === "designer_brief" && !!wf.steps[0]?.promptRef?.textId;
    })
    .toBe(true);

  // Expected output, output name and model on the original.
  await page.getByRole("tab", { name: "Output" }).click();
  const outputName = page.getByLabel("Output name", { exact: true });
  await outputName.fill("concept");
  await outputName.blur();
  const expected = page.getByLabel("Expected output", { exact: true });
  await expected.fill(EXPECTED);
  await expected.blur();
  await page.getByRole("tab", { name: "Model & tools" }).click();
  await pickModel(page, "glm-5-3");

  // Duplicate three times: the copies stay linked (the backend copies the
  // ref) and each gets its own model.
  for (const model of ["sauron", "saruman", "gandalf"]) {
    await page.getByRole("button", { name: "Step actions" }).click();
    await page.getByRole("menuitem", { name: "Duplicate" }).click();
    await page.getByRole("tab", { name: "Model & tools" }).click();
    await pickModel(page, model);
    await page.getByRole("tab", { name: "Output" }).click();
    const copyName = page.getByLabel("Output name", { exact: true });
    await copyName.fill("concept");
    await copyName.blur();
    const copyExpected = page.getByLabel("Expected output", { exact: true });
    await copyExpected.fill(EXPECTED);
    await copyExpected.blur();
  }
  await expect
    .poll(async () => {
      const wf = await currentWorkflow(id);
      const textId = wf.texts[0]?.id ?? "";
      return (
        wf.steps.length === 4 &&
        wf.steps.every(
          (s) => s.promptRef?.textId === textId && s.modelId && s.expectedOutput && s.outputName,
        )
      );
    })
    .toBe(true);

  // Spread the overlapping cards so each is clickable.
  await page.getByTestId("canvas-tidy").click();
  await expect
    .poll(async () => new Set((await currentWorkflow(id)).steps.map((s) => s.canvasX)).size)
    .toBe(4);

  // Definition mode: the text appears once, every step references it.
  await page.goto(`/workflows/${id}/definition`);
  await expect(page.getByTestId("definition-dirty")).toHaveText("Clean");
  const yaml = await downloadYaml(page);
  expect(yaml.match(/designer_brief:/g)?.length).toBe(1);
  expect(yaml.match(/ref: designer_brief/g)?.length).toBe(4);

  // Run it (fake runner): every step run executes the rendered shared text.
  await page.goto(`/workflows/${id}`);
  await page.getByTestId("activate").click();
  await expect(page.getByTestId("run-now")).toBeVisible();
  await page.getByTestId("run-now").click();
  await page.getByRole("button", { name: "View run" }).click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${id}/runs/`));
  await expect(page.getByTestId("run-header")).toContainText("Succeeded");

  // Every step run's evidence shows the rendered shared text as its prompt.
  // The cards can still overlap after tidy, so select each step run through
  // the URL (?step= takes the step run id) instead of clicking cards.
  const runId = page.url().match(/runs\/([^/?#]+)/)![1]!;
  const run = await runs.getRun({ workflowId: id, runId });
  expect(run.run?.stepRuns).toHaveLength(4);
  for (const stepRun of run.run?.stepRuns ?? []) {
    await page.goto(`/workflows/${id}/runs/${runId}?step=${stepRun.id}`);
    const panel = page.getByTestId("step-run-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("configuration-used")).toContainText(PROMPT);
  }
});
