import { defineConfig } from "@playwright/test";

// Boots the full stack (Postgres + backend + Vite dev server) via nix.
// Pass E2E_BASE_URL to point elsewhere; an already-running server on :5173 is
// reused so tests can run against `nix run .#web` started by hand.
// On NixOS the Playwright-downloaded browser cannot run (no system libs); set
// PLAYWRIGHT_CHROMIUM_PATH to a working chromium (e.g. from nixpkgs#chromium).
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  // Tests share one database (create/import/rename); keep them serial.
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "list" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    // Composer defaults to the viewer timezone; pin it so weekly 09:00 UTC
    // is exactly what the user sees and asserts.
    timezoneId: "UTC",
    ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        // Must come first so the stack can reach it when refreshing the model
        // catalog at startup.
        {
          command: "node e2e/mock-velox.mjs",
          url: "http://localhost:9899",
          reuseExistingServer: !process.env.CI,
          timeout: 15_000,
        },
        {
          command: "cd .. && nix run .#web",
          url: "http://localhost:5173",
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          env: {
            GLYPH_STEP_RUNNER: "fake",
            GLYPH_LIVE_HEARTBEAT_SECONDS: "2",
            VELOX_BASE_URL: "http://localhost:9899/v1",
            VELOX_API_KEY: "e2e-test",
          },
        },
      ],
});
