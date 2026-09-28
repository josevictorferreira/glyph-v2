import { defineConfig } from "@playwright/test";
import { createConnection } from "node:net";

// Boots the full stack (Postgres + backend + Vite dev server) via nix.
// `nix run .#web` frees :3000/:5173 with `fuser -k` before starting, so running
// the suite while a hand-started dev stack is up would kill that server — and
// silently reusing it runs against whatever config it has (real runner, dirty
// database). Guard: a running server is only reused when told to
// (E2E_REUSE_SERVER=1, or an explicit E2E_BASE_URL); otherwise the suite
// refuses before booting anything.
// On NixOS the Playwright-downloaded browser cannot run (no system libs); set
// PLAYWRIGHT_CHROMIUM_PATH to a working chromium (e.g. from nixpkgs#chromium).
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "localhost" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

const stackUrl = "http://localhost:5173";

// Workers fork from the coordinating process after it evaluated this config,
// so they inherit the sentinel and skip the check (the stack it started would
// otherwise trip the guard).
const guardSentinel = "GLYPH_E2E_PORTS_CHECKED";
const reuseServer = process.env.E2E_REUSE_SERVER === "1";
if (!process.env[guardSentinel]) {
  process.env[guardSentinel] = "1";
  if (!process.env.E2E_BASE_URL && !reuseServer) {
    const busy = [
      ...(await isListening(5173) ? [":5173"] : []),
      ...(await isListening(3000) ? [":3000"] : []),
    ];
    if (busy.length > 0) {
      throw new Error(
        `Refusing to run e2e: something is already listening on ${busy.join(" and ")} (your dev stack?).\n` +
          `nix run .#web would kill it to free the ports.\n` +
          `Stop it first, or opt into reusing it (it must run the fake runner):\n` +
          `  E2E_REUSE_SERVER=1 — with GLYPH_STEP_RUNNER=fake VELOX_BASE_URL=http://localhost:9899/v1 nix run .#web`,
      );
    }
  }
}

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  // Tests share one database (create/import/rename); keep them serial.
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "list" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? stackUrl,
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
          url: stackUrl,
          reuseExistingServer: reuseServer,
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
