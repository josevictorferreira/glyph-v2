import { test, expect } from "@playwright/test";
import { createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { WorkflowService } from "../src/gen/glyph/v1/workflow_pb";

// Spec 0015 acceptance: renaming a workflow in one tab must reach a second
// tab within 1s — autosave → UpdateWorkflow → WatchWorkflow event →
// invalidation → refetch. The workflow is created over gRPC-Web directly
// (same transport stack the app uses).
test("renaming in one tab updates the other within 1s", async ({ browser }) => {
  const transport = createGrpcWebTransport({
    baseUrl: process.env.E2E_BACKEND_URL ?? "http://localhost:3000",
    useBinaryFormat: true,
  });
  const client = createClient(WorkflowService, transport);
  const name = `Live sync e2e ${Date.now()}`;
  const created = await client.createWorkflow({ name });
  const id = created.workflow?.summary?.id;
  if (!id) throw new Error("createWorkflow returned no workflow id");

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const tabA = await ctxA.newPage();
  const tabB = await ctxB.newPage();
  await tabA.goto(`/workflows/${id}`);
  await tabB.goto(`/workflows/${id}`);

  const nameA = tabA.getByLabel("Workflow name");
  const nameB = tabB.getByLabel("Workflow name");
  await expect(nameA).toHaveValue(name);
  await expect(nameB).toHaveValue(name);
  // Both subscriptions must be up before the 1s window is fair.
  await expect(tabA.getByTestId("connection-indicator")).toContainText("Live");
  await expect(tabB.getByTestId("connection-indicator")).toContainText("Live");

  await nameA.fill("Renamed by tab A");
  await nameA.blur();

  await expect(nameB).toHaveValue("Renamed by tab A", { timeout: 1000 });
  // The header indicator aggregates every field; panels have their own.
  await expect(tabA.getByTestId("workspace-header").getByTestId("save-indicator")).toContainText(
    "Saved",
  );

  await ctxA.close();
  await ctxB.close();
});
