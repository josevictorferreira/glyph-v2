// Run + catalog query hook tests (spec 0015).
import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { RunSchema, StepRunSchema } from "@/gen/glyph/v1/run_pb";
import { ToolDefinitionSchema } from "@/gen/glyph/v1/catalog_pb";
import { renderHookWithApp } from "@test/render";
import { useRuns, useRun, useStepRun } from "./hooks";
import { useModels, useTools } from "../catalog/hooks";

function run(id: string) {
  return create(RunSchema, { id, workflowId: "wf-1" });
}

describe("run hooks", () => {
  it("useRuns lists runs for the workflow", async () => {
    const r = renderHookWithApp(() => useRuns("wf-1"), {
      services: { run: { listRuns: () => ({ runs: [run("r-1"), run("r-2")] }) } },
    });
    await waitFor(() => expect(r.result.current.data?.runs).toHaveLength(2));
    r.unmount();
  });

  it("useRun / useStepRun are disabled without ids", async () => {
    const r1 = renderHookWithApp(() => useRun("wf-1", ""));
    expect(r1.result.current.fetchStatus).toBe("idle");
    r1.unmount();
    const r2 = renderHookWithApp(() => useStepRun("wf-1", "", "s-1"));
    expect(r2.result.current.fetchStatus).toBe("idle");
    r2.unmount();
  });

  it("useStepRun fetches the step run evidence", async () => {
    const r = renderHookWithApp(() => useStepRun("wf-1", "r-1", "s-1"), {
      services: { run: { getStepRun: () => ({ stepRun: create(StepRunSchema, { summary: { id: "s-1" } }) }) } },
    });
    await waitFor(() => expect(r.result.current.data?.stepRun?.summary?.id).toBe("s-1"));
    r.unmount();
  });
});

describe("catalog hooks", () => {
  it("useModels / useTools fetch through the transport", async () => {
    const opts = {
      services: {
        catalog: {
          listModels: () => ({ models: [], stale: false }),
          listTools: () => ({ tools: [create(ToolDefinitionSchema, { key: "bash" })] }),
        },
      },
    } as const;
    const rm = renderHookWithApp(() => useModels(), opts);
    await waitFor(() => expect(rm.result.current.data?.models).toEqual([]));
    rm.unmount();
    const rt = renderHookWithApp(() => useTools(), opts);
    await waitFor(() => expect(rt.result.current.data?.tools[0]?.key).toBe("bash"));
    rt.unmount();
  });
});
