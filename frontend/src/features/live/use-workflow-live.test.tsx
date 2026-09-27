// use-workflow-live tests (spec 0015): scripted fake streams, fake timers.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { GetStepRunResponseSchema } from "@/gen/glyph/v1/run_pb";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { EventType, LiveService, WorkflowEventSchema, type WorkflowEvent } from "@/gen/glyph/v1/live_pb";
import { runKeys, workflowKeys } from "@/shared/api/keys";
import { isLive } from "@/shared/api/liveness";
import { renderHookWithApp } from "@test/render";
import { useWorkflowLive } from "./use-workflow-live";

const ev = (type: EventType, extra: { runId?: string; stepRunId?: string } = {}): WorkflowEvent =>
  create(WorkflowEventSchema, { type, workflowId: "wf", ...extra });

/** Controllable server-streaming fake: tests push events, watchWorkflow yields them. */
function scriptStream() {
  const pending: WorkflowEvent[] = [];
  let wake: (() => void) | undefined;
  const next = () => new Promise<void>((r) => (wake = r));
  return {
    push(event: WorkflowEvent) {
      pending.push(event);
      const w = wake;
      wake = undefined;
      w?.();
    },
    watchWorkflow: async function* (): AsyncIterable<{ event?: WorkflowEvent }> {
      while (true) {
        while (pending.length > 0) yield { event: pending.shift()! };
        await next();
      }
    },
  };
}

/** Flush stream delivery microtasks without advancing wall time. */
const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

/** invalidateQueries calls as comparable queryKey JSON strings. */
const invalidatedKeys = (spy: MockInstance): string[] =>
  spy.mock.calls.map(([f]) => JSON.stringify((f as { queryKey?: unknown } | undefined)?.queryKey));

describe("useWorkflowLive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // deterministic backoff (jitter = 1×)
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const mount = (live: Partial<ServiceImpl<typeof LiveService>>) =>
    renderHookWithApp(() => useWorkflowLive({ workflowId: "wf" }), { services: { live } });

  it("registers liveness while mounted, unregisters on unmount", () => {
    const script = scriptStream();
    const { unmount } = mount(script);
    expect(isLive("wf")).toBe(true);
    unmount();
    expect(isLive("wf")).toBe(false);
  });

  it("invalidates workflow queries on WORKFLOW_UPDATED", async () => {
    const script = scriptStream();
    const { result, queryClient, unmount } = mount(script);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    script.push(ev(EventType.WORKFLOW_UPDATED));
    await flush();
    expect(result.current.status).toBe("connected");
    const keys = invalidatedKeys(invalidate);
    expect(keys).toContain(JSON.stringify(workflowKeys.lists()));
    expect(keys).toContain(JSON.stringify(workflowKeys.detail("wf")));
    unmount();
  });

  it("invalidates run and workflow queries on run lifecycle events", async () => {
    const script = scriptStream();
    const { queryClient, unmount } = mount(script);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    script.push(ev(EventType.RUN_STARTED, { runId: "r1" }));
    await flush();
    const keys = invalidatedKeys(invalidate);
    expect(keys).toContain(JSON.stringify(runKeys.lists("wf")));
    expect(keys).toContain(JSON.stringify(runKeys.detail("wf", "r1")));
    expect(keys).toContain(JSON.stringify(workflowKeys.detail("wf")));
    unmount();
  });

  it("RUN_DELETED also removes the run detail query", async () => {
    const script = scriptStream();
    const { queryClient, transport, unmount } = mount(script);
    const remove = vi.spyOn(queryClient, "removeQueries");

    script.push(ev(EventType.RUN_DELETED, { runId: "r1" }));
    await flush();
    expect(remove).toHaveBeenCalledWith({ queryKey: runKeys.detail("wf", "r1", transport) });
    unmount();
  });

  it("throttles STEP_RUN_PROGRESS to one invalidation per 2s per observed step run", async () => {
    const script = scriptStream();
    const { queryClient, transport, unmount } = mount(script);
    // Observe the step run: its exact query now exists in the cache.
    queryClient.setQueryData(runKeys.stepRun("wf", "r1", "s1", transport), create(GetStepRunResponseSchema));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const stepFilter = JSON.stringify(runKeys.stepRun("wf", "r1", "s1"));
    const stepInvalidations = () => invalidatedKeys(invalidate).filter((k) => k === stepFilter).length;

    script.push(ev(EventType.STEP_RUN_PROGRESS, { runId: "r1", stepRunId: "s1" }));
    await flush();
    script.push(ev(EventType.STEP_RUN_PROGRESS, { runId: "r1", stepRunId: "s1" }));
    await flush();
    script.push(ev(EventType.STEP_RUN_PROGRESS, { runId: "r1", stepRunId: "s1" }));
    await flush();
    expect(stepInvalidations()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    script.push(ev(EventType.STEP_RUN_PROGRESS, { runId: "r1", stepRunId: "s1" }));
    await flush();
    expect(stepInvalidations()).toBe(2);
    unmount();
  });

  it("skips STEP_RUN_PROGRESS for unobserved step runs", async () => {
    const script = scriptStream();
    const { queryClient, unmount } = mount(script);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    script.push(ev(EventType.STEP_RUN_PROGRESS, { runId: "r1", stepRunId: "never-seen" }));
    await flush();
    expect(invalidate).not.toHaveBeenCalled();
    unmount();
  });

  it("RESYNC invalidates everything; HEARTBEAT only refreshes lastEventAt", async () => {
    const script = scriptStream();
    const { result, queryClient, unmount } = mount(script);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    script.push(ev(EventType.RESYNC));
    await flush();
    expect(invalidate).toHaveBeenCalledWith();

    script.push(ev(EventType.HEARTBEAT));
    await flush();
    expect(result.current.lastEventAt).toBe(Date.now());
    unmount();
  });

  it("reconnects with exponential backoff and reports offline after repeated failures", async () => {
    let watchCalls = 0;
    const { result, unmount } = mount({
      watchWorkflow: async function* (): AsyncIterable<{ event?: WorkflowEvent }> {
        watchCalls += 1;
        throw new ConnectError("down", Code.Unavailable);
      },
    });

    // First failure schedules a reconnect after 1s (attempt 0 → 1000ms).
    await flush();
    expect(result.current.status).toBe("reconnecting");
    expect(watchCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await flush();
    expect(watchCalls).toBe(2);
    expect(result.current.status).toBe("reconnecting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flush();
    expect(watchCalls).toBe(3);

    // attempts 3 (8s) and 4 (16s) fail too → fifth state is "offline"
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000 + 8_000 + 16_000);
    });
    await flush();
    expect(watchCalls).toBe(6); // initial + 5 retries
    expect(result.current.status).toBe("offline");
    unmount();
  });

  it("recovers to connected and resets the backoff after a failure", async () => {
    const script = scriptStream();
    let failFirst = true;
    const { result, unmount } = mount({
      watchWorkflow: async function* (): AsyncIterable<{ event?: WorkflowEvent }> {
        if (failFirst) {
          failFirst = false;
          throw new ConnectError("down", Code.Unavailable);
        }
        yield* script.watchWorkflow();
      },
    });

    await flush();
    expect(result.current.status).toBe("reconnecting");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    script.push(ev(EventType.HEARTBEAT));
    await flush();
    expect(result.current.status).toBe("connected");
    unmount();
  });
});
