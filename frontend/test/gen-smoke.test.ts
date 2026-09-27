// Codegen smoke test (0014 task 2): generated services import and the fake
// transport round-trips through them.
import { describe, expect, it } from "vitest";
import { createClient } from "@connectrpc/connect";
import { CatalogService } from "@/gen/glyph/v1/catalog_pb";
import { DefinitionService } from "@/gen/glyph/v1/definition_pb";
import { LiveService } from "@/gen/glyph/v1/live_pb";
import { RunService } from "@/gen/glyph/v1/run_pb";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import { fakeTransport } from "./fakeTransport";

describe("generated services", () => {
  it("exposes the expected typeName and method counts", () => {
    expect(WorkflowService.typeName).toBe("glyph.v1.WorkflowService");
    expect(Object.keys(WorkflowService.methods)).toHaveLength(28);
    expect(RunService.typeName).toBe("glyph.v1.RunService");
    expect(Object.keys(RunService.methods)).toHaveLength(7);
    expect(CatalogService.typeName).toBe("glyph.v1.CatalogService");
    expect(Object.keys(CatalogService.methods)).toHaveLength(3);
    expect(LiveService.typeName).toBe("glyph.v1.LiveService");
    expect(Object.keys(LiveService.methods)).toHaveLength(1);
    expect(DefinitionService.typeName).toBe("glyph.v1.DefinitionService");
    expect(Object.keys(DefinitionService.methods)).toHaveLength(5);
  });

  it("round-trips a unary call through the fake transport", async () => {
    const transport = fakeTransport({
      catalog: {
        listTools: () => ({ tools: [{ key: "t" }, { key: "u" }, { key: "v" }, { key: "w" }] }),
      },
    });
    const client = createClient(CatalogService, transport);
    const res = await client.listTools({});
    expect(res.tools.map((t) => t.key)).toEqual(["t", "u", "v", "w"]);
  });

  it("throws Unimplemented for unregistered handlers", async () => {
    const transport = fakeTransport();
    const client = createClient(WorkflowService, transport);
    await expect(client.listWorkflows({})).rejects.toThrowError(/not implemented/i);
  });
});
