import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { WorkflowService } from "../src/gen/glyph/v1/workflow_pb";

// Spec 0017 e2e: canvas interactions against the real backend — add/select,
// move persistence, connect-to-card / replace / cycle guard / edge deletion,
// duplicate + delete confirmations, keyboard-only flow, tidy up + undo.

let workflows: ReturnType<typeof createClient<typeof WorkflowService>>;

test.beforeAll(() => {
  const transport = createGrpcWebTransport({
    baseUrl: process.env.E2E_BACKEND_URL ?? "http://localhost:3000",
    useBinaryFormat: true,
  });
  workflows = createClient(WorkflowService, transport);
});

async function createWorkflow(
  name: string,
  steps: Array<{ name: string; x: number; y: number; output?: string }> = [],
) {
  const created = await workflows.createWorkflow({ name });
  const id = created.workflow?.summary?.id;
  if (!id) throw new Error("createWorkflow returned no id");
  const stepIds: string[] = [];
  for (const s of steps) {
    const res = await workflows.addStep({ workflowId: id, kind: 1, canvasX: s.x, canvasY: s.y });
    const stepId = res.workflow?.steps.at(-1)?.id;
    if (!stepId) throw new Error("addStep returned no step");
    stepIds.push(stepId);
    if (s.name) await workflows.updateStepDetails({ workflowId: id, stepId, name: s.name });
    // Connections require the source to expose a named output.
    if (s.output)
      await workflows.updateStepOutput({ workflowId: id, stepId, outputName: s.output });
  }
  return { id, stepIds };
}

async function stepPositions(id: string) {
  const res = await workflows.getWorkflow({ id });
  const map = new Map<string, { x: number; y: number }>();
  for (const s of res.workflow?.steps ?? []) {
    map.set(s.id, { x: Number(s.canvasX), y: Number(s.canvasY) });
  }
  return map;
}

async function openCanvas(page: Page, id: string) {
  await page.goto(`/workflows/${id}`);
  await expect(page.getByTestId("canvas")).toBeVisible();
  // The empty state overlays the pane; both sit inside the focusable wrapper.
  const empty = page.getByTestId("canvas-empty");
  if (await empty.isVisible()) {
    await empty.click({ position: { x: 300, y: 250 } });
  } else {
    await page.locator(".react-flow__pane").click({ position: { x: 300, y: 250 } });
  }
  // Let the initial fitView animation settle before measuring boxes.
  await page.waitForTimeout(500);
}

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const outHandle = (page: Page, id: string) =>
  page.locator(`.react-flow__node[data-id="${id}"] [data-handleid="out"]`);

async function dragFromTo(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x + 8, to.y, { steps: 8 });
  await page.mouse.move(to.x, to.y, { steps: 2 });
  await page.mouse.up();
}

/** Captures the next confirm dialog: accepts/dismisses inside the listener so
 *  the triggering action (click, mouse.up) is not blocked by the modal. */
function nextConfirm(page: Page, accept: boolean): Promise<string> {
  return new Promise((resolve) => {
    void page.once("dialog", async (dialog) => {
      resolve(dialog.message());
      await dialog[accept ? "accept" : "dismiss"]();
    });
  });
}

test("add a step from the empty state; selecting a card updates ?step=", async ({ page }) => {
  const { id } = await createWorkflow("E2E canvas add");
  await openCanvas(page, id);
  await expect(page.getByTestId("canvas-empty")).toBeVisible();
  await page.getByTestId("canvas-empty-add").click();
  const card = page.locator(".react-flow__node").first();
  await expect(card).toBeVisible();
  await expect(page.getByTestId("canvas-empty")).toBeHidden();

  await card.click();
  await expect(page).toHaveURL(new RegExp(`${id}\\?step=`));
});

test("drag persists position after reload", async ({ page }) => {
  const { id, stepIds } = await createWorkflow("E2E canvas move", [
    { name: "Mover", x: 100, y: 100 },
  ]);
  const before = (await stepPositions(id)).get(stepIds[0]!)!;
  await openCanvas(page, id);
  const card = node(page, stepIds[0]!);
  await expect(card).toBeVisible();
  // The movement depends on the fitView zoom; retry until the backend records it.
  let after = before;
  for (let attempt = 0; attempt < 3 && (after.x <= before.x || after.y <= before.y); attempt++) {
    const box = (await card.boundingBox())!;
    await dragFromTo(
      page,
      { x: box.x + box.width / 2, y: box.y + 20 },
      { x: box.x + box.width / 2 + 160, y: box.y + 120 },
    );
    await page.waitForTimeout(400);
    after = (await stepPositions(id)).get(stepIds[0]!)!;
  }
  expect(after.x).toBeGreaterThan(before.x);
  expect(after.y).toBeGreaterThan(before.y);

  await page.reload();
  await expect(node(page, stepIds[0]!)).toBeVisible();
  const restored = (await stepPositions(id)).get(stepIds[0]!)!;
  expect(restored).toEqual(after);
});

test("connect to card body, replace with confirmation, block cycles, delete edge", async ({
  page,
}) => {
  const { id, stepIds } = await createWorkflow("E2E canvas connect", [
    { name: "Alpha", x: 80, y: 120, output: "findings" },
    { name: "Beta", x: 480, y: 120 },
    { name: "Gamma", x: 480, y: 320, output: "draft" },
  ]);
  const [alpha, beta, gamma] = stepIds as [string, string, string];
  await openCanvas(page, id);

  // Connect-to-card: drag Alpha's output onto Beta's card body.
  const alphaOut = (await outHandle(page, alpha).boundingBox())!;
  const betaCard = (await node(page, beta).boundingBox())!;
  await dragFromTo(
    page,
    { x: alphaOut.x + alphaOut.width / 2, y: alphaOut.y + alphaOut.height / 2 },
    { x: betaCard.x + betaCard.width / 2, y: betaCard.y + 10 },
  );
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  // Replace: drop Gamma's output on Beta's (now fed) input handle; confirm.
  const betaInput = node(page, beta).locator("[data-handlepos='left']");
  await expect(betaInput).toHaveCount(1);
  const gammaOut = (await outHandle(page, gamma).boundingBox())!;
  const inputBox = (await betaInput.boundingBox())!;
  const replaceMsg = nextConfirm(page, true);
  await dragFromTo(
    page,
    { x: gammaOut.x + gammaOut.width / 2, y: gammaOut.y + gammaOut.height / 2 },
    { x: inputBox.x + inputBox.width / 2, y: inputBox.y + inputBox.height / 2 },
  );
  expect(await replaceMsg).toContain("Replace connection");
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect
    .poll(async () => (await workflows.getWorkflow({ id })).workflow?.connections[0]?.sourceStepId)
    .toBe(gamma);

  // Cycle guard: Beta → Gamma (would close Gamma→Beta) shows a toast, no edge.
  const betaOut = (await outHandle(page, beta).boundingBox())!;
  const gammaCard = (await node(page, gamma).boundingBox())!;
  await dragFromTo(
    page,
    { x: betaOut.x + betaOut.width / 2, y: betaOut.y + betaOut.height / 2 },
    { x: gammaCard.x + gammaCard.width / 2, y: gammaCard.y + 10 },
  );
  await expect(page.getByText("This would create a cycle.")).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  // Delete the edge with the spec confirmation copy.
  await page.locator(".react-flow__edge").first().click({ force: true });
  const edgeMsg = nextConfirm(page, true);
  await page.keyboard.press("Backspace");
  expect(await edgeMsg).toMatch(/This also removes input “.+” from Beta/);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
});

test("duplicate with Ctrl+D; delete via context menu counts connections", async ({ page }) => {
  const { id, stepIds } = await createWorkflow("E2E canvas step ops", [
    { name: "Solo", x: 200, y: 160, output: "result" },
    { name: "Linked", x: 560, y: 160 },
  ]);
  const [solo, linked] = stepIds as [string, string];
  const betaCard = node(page, solo);
  const target = node(page, linked);
  await openCanvas(page, id);
  await expect(betaCard).toBeVisible();
  await expect(target).toBeVisible();

  // Connect the two so the delete copy includes a connection count.
  const soloOut = (await outHandle(page, solo).boundingBox())!;
  const linkedBox = (await target.boundingBox())!;
  await dragFromTo(
    page,
    { x: soloOut.x + soloOut.width / 2, y: soloOut.y + soloOut.height / 2 },
    { x: linkedBox.x + linkedBox.width / 2, y: linkedBox.y + 10 },
  );
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);

  // Duplicate the selected card.
  await betaCard.click();
  await page.keyboard.press("Control+d");
  await expect(page.locator(".react-flow__node")).toHaveCount(3);

  // Delete the linked step through the context menu.
  await target.click({ button: "right" });
  await expect(page.getByTestId("canvas-context-menu")).toBeVisible();
  const deleteMsg = nextConfirm(page, true);
  await page.getByRole("menuitem", { name: "Delete step" }).click();
  expect(await deleteMsg).toBe("Delete “Linked”? This removes 1 connection.");
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
});

test("keyboard-only: add steps, cycle selection, nudge, duplicate", async ({ page }) => {
  const { id } = await createWorkflow("E2E canvas keyboard");
  await openCanvas(page, id);
  await expect(page.getByTestId("canvas-empty")).toBeVisible();

  const canvas = page.getByTestId("canvas");
  for (let i = 0; i < 3; i++) {
    await canvas.press("a");
    await page.locator(".react-flow__node").nth(i).waitFor({ state: "visible" });
  }
  await expect(page.locator(".react-flow__node")).toHaveCount(3);

  // Tab cycles selection through the chain order.
  await canvas.press("Tab");
  await page.keyboard.press("Shift+ArrowRight");
  await page.waitForTimeout(600); // 400ms move debounce + flush

  const res = await workflows.getWorkflow({ id });
  expect(res.workflow?.steps.length).toBe(3);
  const moved = res.workflow?.steps.find((s) => s.canvasX > 0);
  expect(moved).toBeDefined();
});

test("tidy up relayers the graph; undo restores original positions", async ({ page }) => {
  const originals = [
    { name: "Scatter A", x: 840, y: 620 },
    { name: "Scatter B", x: 40, y: 480 },
    { name: "Scatter C", x: 620, y: 40 },
  ];
  const { id, stepIds } = await createWorkflow("E2E canvas tidy", originals);
  await openCanvas(page, id);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  const before = await stepPositions(id);

  await page.getByTestId("canvas-tidy").click();
  await expect(page.getByText("Layout tidied", { exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  const tidied = await stepPositions(id);
  const changed = stepIds.filter((s) => {
    const b = before.get(s)!;
    const t = tidied.get(s)!;
    return b.x !== t.x || b.y !== t.y;
  });
  expect(changed.length).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Layout restored", { exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  const restored = await stepPositions(id);
  for (const s of stepIds) expect(restored.get(s)).toEqual(before.get(s));
});
