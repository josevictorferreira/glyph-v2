import { test, expect } from "@playwright/test";

// 0016: shell loads with the library sidebar wired in (Home content varies
// with the database, so assert on the shell itself).
test("app shell loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByTestId("library-sidebar").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Home" }).first()).toBeVisible();
  // Primary nav lives in the single top bar: all three links fully visible
  // (Settings used to be clipped by the sidebar's fixed-width strip).
  const banner = page.getByRole("banner");
  for (const name of ["Home", "Chat", "Settings"]) {
    const link = banner.getByRole("link", { name, exact: true });
    await expect(link).toBeVisible();
    expect(await link.boundingBox(), `${name} must not be clipped`).not.toBeNull();
  }
});
