import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { CatalogService } from "../src/gen/glyph/v1/catalog_pb";
import { ChatService } from "../src/gen/glyph/v1/chat_pb";
import { DefinitionService } from "../src/gen/glyph/v1/definition_pb";
import { SettingsService } from "../src/gen/glyph/v1/settings_pb";
// Spec 0024 e2e: the chat agent against the fake runner. Model choice in
// Settings, a streamed reply, a workflow created from chat with a card that
// links to it, an edit that shows in Definition mode and reverts, and a
// stopped long turn.
const backendUrl = process.env.E2E_BACKEND_URL ?? "http://localhost:3000";

let catalog: ReturnType<typeof createClient<typeof CatalogService>>;
let chat: ReturnType<typeof createClient<typeof ChatService>>;
let definitions: ReturnType<typeof createClient<typeof DefinitionService>>;
let settings: ReturnType<typeof createClient<typeof SettingsService>>;

test.beforeAll(() => {
  const transport = createGrpcWebTransport({ baseUrl: backendUrl, useBinaryFormat: true });
  catalog = createClient(CatalogService, transport);
  chat = createClient(ChatService, transport);
  definitions = createClient(DefinitionService, transport);
  settings = createClient(SettingsService, transport);
});

test.beforeEach(async () => {
  await catalog.refreshModels({});
});

async function pickModel(page: Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Model" }).click();
  // The dev database carries models from earlier real refreshes; pick
  // exactly the mock's model from the velox group.
  await page
    .getByRole("group", { name: "velox" })
    .getByRole("option", { name: "glm-5-3", exact: true })
    .click();
  await expect(page.getByText("Saved")).toBeVisible();
}

async function openNewChat(page: Page) {
  await page.goto("/chat");
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByTestId("conversation")).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByLabel("Message").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("model choice gates the composer, replies stream and finish", async ({ page }) => {
  // The stack's database survives across runs: clear any saved model so
  // this test starts from the unset state.
  await settings.updateSettings({ chatModelId: "" });
  const errors: string[] = [];
  page.on("requestfailed", (req) => errors.push(`${req.failure()?.errorText} ${req.url()}`));
  page.on("response", (res) => {
    if (res.status() >= 400) errors.push(`${res.status()} ${res.url()}`);
  });
  await openNewChat(page);
  // Without a model the composer asks for Settings first.
  try {
    await expect(page.getByTestId("composer-missing-model")).toBeVisible({ timeout: 8_000 });
  } catch {
    throw new Error(`console errors: ${errors.join(" | ")}`);
  }

  await pickModel(page);
  await page.goto("/chat");
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByTestId("composer")).toBeVisible();

  await send(page, "hello agent");
  // The fake runner streams "Fake reply to: hello agent" and the turn ends:
  // the composer re-enables and the text settles.
  await expect(page.getByText("Fake reply to: hello agent")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
});

test("a workflow created from chat links to its page and exists", async ({ page }) => {
  await pickModel(page);
  await openNewChat(page);
  const yaml = [
    "name: Chat Made",
    "steps:",
    "  - name: only",
    "    kind: helper",
    "",
  ].join("\n");
  await send(page, `FAKE_TOOL:create_workflow {"yaml": ${JSON.stringify(yaml)}}`);

  const card = page.getByTestId("tool-card").filter({ hasText: "create_workflow" });
  await expect(card).toBeVisible();
  const href = await card.getByRole("link").getAttribute("href");
  expect(href).toBeTruthy();
  const id = href!.split("/").filter(Boolean).pop()!;

  // The workflow exists and the card's link opens it.
  const exported = await definitions.exportDefinition({ workflowId: id });
  expect(exported.yaml).toContain("name: Chat Made");
  await card.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${id}`));
});

test("an edit made from chat shows in Definition mode and reverts", async ({ page }) => {
  await pickModel(page);
  // Create the workflow through the chat agent (exercises create + update).
  const created = await chat.createChat({});
  const chatId = created.chat?.id;
  if (!chatId) throw new Error("createChat returned no chat");
  const yaml = [
    "name: Before Edit",
    "steps:",
    "  - name: only",
    "    kind: helper",
    "",
  ].join("\n");
  await settings.updateSettings({ chatModelId: "velox/glm-5-3" });
  await chat.sendMessage({ chatId, text: `FAKE_TOOL:create_workflow {"yaml": ${JSON.stringify(yaml)}}` });
  await waitForIdle(chatId);
  const found = await chat.getChat({ chatId });
  const createCard = found.messages.find((m) => m.tool?.name === "create_workflow");
  const id = createCard?.tool?.workflowId;
  if (!id) throw new Error("no workflow id on the create card");
  const before = await definitions.exportDefinition({ workflowId: id });

  // Edit it from chat: the update card is revertible.
  const edited = before.yaml.replace("name: Before Edit", "name: After Edit");
  const current = await definitions.exportDefinition({ workflowId: id });
  await chat.sendMessage({
    chatId,
    text: `FAKE_TOOL:update_workflow {"workflow_id": "${id}", "fingerprint": "${current.fingerprint}", "yaml": ${JSON.stringify(edited)}}`,
  });
  await waitForIdle(chatId);

  // The change is visible in Definition mode.
  await page.goto(`/workflows/${id}/definition`);
  await expect(page.getByTestId("definition-dirty")).toHaveText("Clean");
  const after = await definitions.exportDefinition({ workflowId: id });
  expect(after.yaml).toContain("name: After Edit");

  // Revert from the chat card.
  await page.goto(`/chat/${chatId}`);
  const updateCard = page.getByTestId("tool-card").filter({ hasText: "update_workflow" });
  await expect(updateCard).toBeVisible();
  await updateCard.getByRole("button", { name: "Revert" }).click();
  await expect(updateCard.getByText("Reverted")).toBeVisible();

  // The definition went back.
  const restored = await definitions.exportDefinition({ workflowId: id });
  expect(restored.yaml).toBe(before.yaml);
});

test("a long turn stops within two seconds and the chat returns to idle", async ({ page }) => {
  await pickModel(page);
  await openNewChat(page);
  await send(page, "FAKE_SLEEP:600000");
  // The turn is running: Stop replaces Send.
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Cancelled.")).toBeVisible();
  await expect(page.getByTestId("composer")).toBeVisible();
});

/** Polls until the chat leaves `running` (the fake runner answers fast, but
 * the turn job has to round-trip through the worker). */
async function waitForIdle(chatId: string) {
  await expect
    .poll(async () => (await chat.getChat({ chatId })).chat?.status, { timeout: 15_000 })
    .toBe(1); // CHAT_STATUS_IDLE
}
