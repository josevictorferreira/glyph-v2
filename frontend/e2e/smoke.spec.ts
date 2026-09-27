import { test, expect } from "@playwright/test";

// 0016: shell loads with the library sidebar wired in (Home content varies
// with the database, so assert on the shell itself).
test("app shell loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByTestId("library-sidebar").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Home" }).first()).toBeVisible();
});
