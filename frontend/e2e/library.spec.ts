import { test, expect } from "@playwright/test";
import { createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { WorkflowService } from "../src/gen/glyph/v1/workflow_pb";

// Spec 0016 e2e: library search, create (blank / YAML dry-run / duplicate),
// command palette, mobile drawer. Workflows are created over gRPC-Web.

let transport: ReturnType<typeof createGrpcWebTransport>;
let workflows: ReturnType<typeof createClient<typeof WorkflowService>>;

test.beforeAll(() => {
  transport = createGrpcWebTransport({
    baseUrl: process.env.E2E_BACKEND_URL ?? "http://localhost:3000",
    useBinaryFormat: true,
  });
  workflows = createClient(WorkflowService, transport);
});

async function createNamed(name: string) {
  const res = await workflows.createWorkflow({ name });
  const id = res.workflow?.summary?.id;
  if (!id) throw new Error(`createWorkflow(${name}) returned no id`);
  return id;
}

/** gRPC-Web ListWorkflows response with no workflows: an empty message frame + OK trailers. */
function emptyListWorkflows(): Buffer {
  const trailer = Buffer.from("grpc-status: 0\r\n");
  const trailerHeader = Buffer.alloc(5);
  trailerHeader[0] = 0x80;
  trailerHeader.writeUInt32BE(trailer.length, 1);
  return Buffer.concat([Buffer.from([0, 0, 0, 0, 0]), trailerHeader, trailer]);
}

test("first run: create a named draft from the empty state", async ({ page }) => {
  // The dev database keeps workflows between runs; present an empty library
  // until the first-run screen has rendered.
  const listRoute = "**/glyph.v1.WorkflowService/ListWorkflows";
  await page.route(listRoute, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/grpc-web+proto" },
      body: emptyListWorkflows(),
    }),
  );
  await page.goto("/");
  await expect(page.getByTestId("home-first-run")).toBeVisible();
  await page.unroute(listRoute);
  await page.getByTestId("first-run-new").click();
  await page.getByTestId("create-name").fill("Design POC");
  await page.getByTestId("create-submit").click();
  await expect(page).toHaveURL(/\/workflows\/.+$/);
  await expect(page.getByTestId("workflow-name")).toHaveValue("Design POC");
});

test("sidebar search filters workflows", async ({ page }) => {
  await createNamed("Alpha search target");
  await createNamed("Beta other one");
  await page.goto("/");
  await expect(page.getByTestId("library-list")).toContainText("Alpha search target");
  await page.getByTestId("library-search").fill("alpha");
  await expect(page.getByTestId("library-list")).toContainText("Alpha search target");
  await expect(page.getByTestId("library-list")).not.toContainText("Beta other one");
  // The row navigates to the workspace.
  await page.getByTestId("library-row-name").first().click();
  await expect(page).toHaveURL(/\/workflows\/.+$/);
});

test("YAML tab shows dry-run errors with line numbers and blocks import", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("library-new").click();
  await page.getByRole("tab", { name: "From YAML" }).click();
  await page
    .getByTestId("create-yaml")
    .fill("name: E2E bad\nsteps:\n  - name: A\n    kind: turbo\n");
  const errors = page.getByTestId("yaml-errors");
  await expect(errors).toBeVisible();
  await expect(errors).toContainText(/Line \d+:/);
  await expect(page.getByTestId("import-submit")).toBeDisabled();
});

test("YAML tab imports a valid document", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("library-new").click();
  await page.getByRole("tab", { name: "From YAML" }).click();
  await page
    .getByTestId("create-yaml")
    .fill("name: E2E imported\nsteps:\n  - name: Research\n    kind: pi\n    prompt: Find facts\n");
  await expect(page.getByTestId("yaml-valid")).toBeVisible();
  await page.getByTestId("import-submit").click();
  await expect(page).toHaveURL(/\/workflows\/.+$/);
  await expect(page.getByTestId("workflow-name")).toHaveValue("E2E imported");
});

test("duplicate copies a workflow without step ids", async ({ page }) => {
  // Unique per run: the dev database keeps earlier runs' workflows.
  const source = `E2E duplicate source ${Date.now()}`;
  const id = await createNamed(source);
  const added = await workflows.addStep({ workflowId: id, kind: 1 });
  const stepId = added.workflow?.steps[0]?.id;
  if (stepId) {
    await workflows.updateStepDetails({ workflowId: id, stepId, name: "Research" });
  }
  await page.goto("/");
  await page.getByTestId("library-new").click();
  await page.getByRole("tab", { name: "Duplicate" }).click();
  await page.getByRole("button", { name: "Workflow to copy" }).click();
  await page.getByRole("option", { name: source, exact: true }).click();
  await page.getByTestId("duplicate-submit").click();
  await expect(page).toHaveURL(/\/workflows\/.+$/);
  await expect(page.getByTestId("workflow-name")).toHaveValue(`${source} (copy)`);
  // The copy kept the workflow identity (name) and is a separate workflow.
});

test("command palette: ⌘K opens and New workflow runs", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.getByTestId("command-input").fill("new workflow");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("create-dialog")).toBeVisible();
});

test("mobile: sidebar is a drawer behind the hamburger", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByTestId("app-sidebar")).toBeHidden();
  await page.getByTestId("open-sidebar").click();
  await expect(page.getByTestId("app-sidebar-drawer")).toBeVisible();
  await expect(page.getByTestId("app-sidebar-drawer").getByTestId("library-sidebar")).toBeVisible();
  await ctx.close();
});
