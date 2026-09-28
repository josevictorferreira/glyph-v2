// Playwright gates the webServer on Vite (:5173); the backend on :3000 can
// finish booting later (first compile, migrations). Wait here, outside any
// test timeout, so specs never race the backend.
const backendUrl = process.env.E2E_BACKEND_URL ?? "http://localhost:3000";

export default async function globalSetup() {
  for (let i = 0; i < 180; i++) {
    try {
      if ((await fetch(`${backendUrl}/up`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`backend at ${backendUrl} did not come up`);
}
