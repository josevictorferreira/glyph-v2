import { createGrpcWebTransport } from "@connectrpc/connect-web";

// The single app transport (spec 0013/0014). Same-origin in dev (Vite proxy)
// and in production (backend serves the SPA); VITE_API_BASE_URL opts out for
// direct cross-origin use. Binary format keeps payloads small and matches the
// backend's native gRPC-Web framing.
export const transport = createGrpcWebTransport({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "",
  useBinaryFormat: true,
});
