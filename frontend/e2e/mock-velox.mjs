// Mock velox /models endpoint for e2e runs (spec 0019): activation requires a
// model in the catalog, and the catalog is refreshed from provider gateways.
// Without provider keys the catalog stays empty, so the e2e stack points
// VELOX_BASE_URL at this server. Serves the tournament's models (spec 0023
// picks a different one per duplicated step); the catalog stores them as
// "velox/<id>" (model_available matches the full and the bare id).
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_VELOX_PORT ?? 9899);

createServer((req, res) => {
  const send = (body, type = "application/json") => {
    res.writeHead(200, { "content-type": type });
    res.end(body);
  };
  if (req.method === "GET" && req.url === "/v1/models") {
    send(
      JSON.stringify({
        data: ["glm-5-3", "sauron", "saruman", "gandalf"].map((id) => ({ id })),
      }),
    );
    return;
  }
  send("{}");
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`mock velox listening on :${PORT}\n`);
});
