// Definition mode tests (spec 0021): export → edit → apply paths, problem
// rows, live re-export vs banner, conflict resolutions, download/copy and the
// unsaved-changes blocker. Monaco is mocked (jsdom cannot run its worker).
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  ApplyDefinitionResponseSchema,
  ExportDefinitionResponseSchema,
  ParseDefinitionResponseSchema,
  type ApplyDefinitionRequest,
  type ExportDefinitionResponse,
  type ParseDefinitionRequest,
} from "@/gen/glyph/v1/definition_pb";
import { DefinitionErrorSchema, DefinitionErrorsSchema } from "@/gen/glyph/v1/common_pb";
import { WorkflowSchema } from "@/gen/glyph/v1/workflow_pb";
import {
  EventType,
  LiveService,
  WatchWorkflowResponseSchema,
  WorkflowEventSchema,
  type WorkflowEvent,
} from "@/gen/glyph/v1/live_pb";
import type { FakeServices } from "@test/fakeTransport";
import { renderWithApp } from "@test/render";
import { LiveProvider } from "@/features/live";
import { DefinitionMode } from "./Definition";

vi.mock("./YamlEditor", () => ({
  YamlEditor: (props: {
    value: string;
    "data-testid"?: string;
    onChange?: (v: string) => void;
    onSave?: () => void;
  }) => (
    <div>
      <textarea
        aria-label="yaml"
        data-testid={props["data-testid"] ?? "definition-editor"}
        value={props.value}
        onChange={(e) => props.onChange?.(e.target.value)}
      />
      <button type="button" data-testid="mock-editor-save" onClick={() => props.onSave?.()}>
        save
      </button>
    </div>
  ),
}));
vi.mock("./YamlDiff", () => ({
  YamlDiff: (props: { original: string; modified: string }) => (
    <div
      data-testid="yaml-diff"
      data-original={props.original}
      data-modified={props.modified}
    />
  ),
}));

afterEach(() => vi.restoreAllMocks());

const START: ExportDefinitionResponse = create(ExportDefinitionResponseSchema, {
  yaml: "name: Demo\n",
  fingerprint: "fp-1",
  filename: "demo.yml",
});

/** Mutable server state + a definition service wired to it. */
function makeServer(start: ExportDefinitionResponse = START) {
  const server = {
    exported: start,
    applied: [] as ApplyDefinitionRequest[],
    invalidOnApply: null as Array<{ line?: number; message: string }> | null,
  };
  const definition = {
    exportDefinition: vi.fn(async () =>
      create(ExportDefinitionResponseSchema, server.exported),
    ),
    parseDefinition: vi.fn(async (req: ParseDefinitionRequest) => {
      const errors = req.yaml.includes("bogus")
        ? [{ line: 2, message: '"bogus" is not a known key here.' }]
        : [];
      return create(ParseDefinitionResponseSchema, { errors });
    }),
    applyDefinition: vi.fn(async (req: ApplyDefinitionRequest) => {
      server.applied.push(req);
      if (server.invalidOnApply) {
        throw new ConnectError("invalid definition", Code.InvalidArgument, undefined, [
          {
            desc: DefinitionErrorsSchema,
            value: create(DefinitionErrorsSchema, {
              errors: server.invalidOnApply.map((e) => create(DefinitionErrorSchema, e)),
            }),
          },
        ]);
      }
      if (req.fingerprint !== server.exported.fingerprint) {
        throw new ConnectError("stale fingerprint", Code.Aborted);
      }
      const fingerprint = `fp-applied-${server.applied.length}`;
      server.exported = { ...server.exported, yaml: req.yaml, fingerprint };
      return create(ApplyDefinitionResponseSchema, {
        workflow: create(WorkflowSchema, { summary: { id: "wf-1", name: "Demo" } }),
        issues: [],
        newFingerprint: fingerprint,
      });
    }),
  };
  return { server, definition };
}

function mountDefinition(services: FakeServices, opts: { withLive?: boolean } = {}) {
  const rootRoute = createRootRoute();
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () =>
      opts.withLive ? (
        <LiveProvider workflowId="wf-1">
          <DefinitionMode workflowId="wf-1" />
        </LiveProvider>
      ) : (
        <DefinitionMode workflowId="wf-1" />
      ),
  });
  const other = createRoute({
    getParentRoute: () => rootRoute,
    path: "/other",
    component: () => <p data-testid="other-page">Other</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, other]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return { ...renderWithApp(<RouterProvider router={router} />, { services }), router };
}

/** A watchWorkflow fake tests can push events into. */
function pushableLive() {
  const queue: WorkflowEvent[] = [];
  const live: Partial<ServiceImpl<typeof LiveService>> = {
    watchWorkflow: async function* () {
      for (;;) {
        if (queue.length > 0) {
          yield create(WatchWorkflowResponseSchema, { event: queue.shift() });
        } else {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
    },
  };
  return {
    live,
    push: (type: EventType) =>
      queue.push(
        create(WorkflowEventSchema, { type, workflowId: "wf-1", occurredAt: { seconds: 1n } }),
      ),
  };
}

const editor = () => screen.getByTestId("definition-editor") as HTMLTextAreaElement;

function edit(text: string) {
  // userEvent.type parses []{} as key descriptors; we only need the change.
  fireEvent.change(editor(), { target: { value: text } });
}

async function mounted(services: FakeServices) {
  const result = mountDefinition(services);
  await waitFor(() => expect(editor().value).toBe("name: Demo\n"));
  return result;
}

describe("definition mode — load and dry run", () => {
  it("shows the export, clean badge, and dry-run problems on their line", async () => {
    const { server, definition } = makeServer();
    await mounted({ definition });

    expect(screen.getByTestId("definition-dirty")).toHaveTextContent("Clean");
    expect(screen.queryByTestId("definition-problems")).toBeNull();

    await edit("name: Demo\nbogus: 1\n");
    expect(screen.getByTestId("definition-dirty")).toHaveTextContent("Edited");

    await waitFor(
      () => expect(screen.getByTestId("definition-problems")).toBeInTheDocument(),
      { timeout: 4000 },
    );
    expect(screen.getByTestId("definition-problem")).toHaveTextContent(
      'Line 2: "bogus" is not a known key here.',
    );
    expect(definition.parseDefinition.mock.calls[0]?.[0]).toMatchObject({
      workflowId: "wf-1",
      yaml: "name: Demo\nbogus: 1\n",
    });
    expect(server.applied).toEqual([]);
  });
});

describe("definition mode — apply", () => {
  it("applies with the current fingerprint and adopts the server formatting", async () => {
    const { server, definition } = makeServer();
    // Normalize on apply: the export differs from what was sent.
    definition.applyDefinition.mockImplementation(async (req: ApplyDefinitionRequest) => {
      server.applied.push(req);
      server.exported = { ...server.exported, yaml: `${req.yaml}# canonical\n`, fingerprint: "fp-2" };
      return create(ApplyDefinitionResponseSchema, {
        workflow: create(WorkflowSchema, { summary: { id: "wf-1", name: "Demo" } }),
        issues: [],
        newFingerprint: "fp-2",
      });
    });
    await mounted({ definition });

    await edit("name: Demo 2\n");
    await userEvent.setup().click(screen.getByTestId("apply-changes"));

    await screen.findByText("Applied"); // toast
    expect(server.applied).toMatchObject([
      { workflowId: "wf-1", yaml: "name: Demo 2\n", fingerprint: "fp-1" },
    ]);
    await waitFor(() => expect(editor().value).toBe("name: Demo 2\n# canonical\n"));
    expect(screen.getByTestId("definition-dirty")).toHaveTextContent("Clean");
  });

  it("surfaces INVALID_ARGUMENT definition errors as problems, applying nothing", async () => {
    const { server, definition } = makeServer();
    server.invalidOnApply = [{ line: 1, message: 'map "steps" is not allowed here.' }];
    await mounted({ definition });

    await edit("name: Demo\nsteps: []\n");
    await userEvent.setup().click(screen.getByTestId("apply-changes"));

    await screen.findByText('map "steps" is not allowed here.');
    expect(screen.getByTestId("definition-problem")).toHaveTextContent(
      'Line 1: map "steps" is not allowed here.',
    );
    expect(server.applied).toHaveLength(1); // attempted, but nothing changed
    expect(screen.getByTestId("definition-dirty")).toHaveTextContent("Edited");
  });
});

describe("definition mode — conflict", () => {
  async function conflicted() {
    const { server, definition } = makeServer();
    await mounted({ definition });
    await edit("name: Mine\n");
    // Someone else applied while we were editing.
    server.exported = create(ExportDefinitionResponseSchema, {
      yaml: "name: Theirs\n",
      fingerprint: "fp-theirs",
      filename: "demo.yml",
    });
    await userEvent.setup().click(screen.getByTestId("apply-changes"));
    await screen.findByTestId("definition-conflict");
    return { server, definition };
  }

  it("shows a diff and discards my text on 'Discard my changes'", async () => {
    const { server } = await conflicted();
    expect(screen.getByTestId("yaml-diff")).toHaveAttribute("data-original", "name: Theirs\n");
    expect(screen.getByTestId("yaml-diff")).toHaveAttribute("data-modified", "name: Mine\n");

    await userEvent.setup().click(screen.getByTestId("conflict-discard"));
    await waitFor(() => expect(screen.queryByTestId("definition-conflict")).toBeNull());
    expect(editor().value).toBe("name: Theirs\n");
    expect(screen.getByTestId("definition-dirty")).toHaveTextContent("Clean");
    // The stale cached export must not revert the editor.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(editor().value).toBe("name: Theirs\n");
    expect(server.applied).toHaveLength(1);
  });

  it("'Keep editing on top of latest' keeps my text and applies against the latest fingerprint", async () => {
    const { server } = await conflicted();
    await userEvent.setup().click(screen.getByTestId("conflict-keep-mine"));

    expect(screen.queryByTestId("definition-conflict")).toBeNull();
    expect(editor().value).toBe("name: Mine\n");
    expect(screen.getByTestId("definition-dirty")).toHaveTextContent("Edited");

    await userEvent.setup().click(screen.getByTestId("apply-changes"));
    await screen.findByText("Applied");
    expect(server.applied[1]).toMatchObject({ yaml: "name: Mine\n", fingerprint: "fp-theirs" });
  });

  it("'Overwrite latest' confirms, then applies my text with the latest fingerprint", async () => {
    const { server } = await conflicted();
    await userEvent.setup().click(screen.getByTestId("conflict-overwrite"));
    await screen.findByTestId("overwrite-dialog");
    await userEvent.setup().click(screen.getByTestId("overwrite-confirm"));

    await screen.findByText("Applied");
    expect(server.applied[1]).toMatchObject({ yaml: "name: Mine\n", fingerprint: "fp-theirs" });
    await waitFor(() => expect(screen.queryByTestId("definition-conflict")).toBeNull());
    expect(editor().value).toBe("name: Mine\n");
  });
});

describe("definition mode — download and copy", () => {
  it("downloads a .yml Blob under the exported filename", async () => {
    const { definition } = makeServer();
    await mounted({ definition });

    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");
    let downloadedName = "";
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadedName = this.download;
      });
    await userEvent.setup().click(screen.getByTestId("download-yml"));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("text/yaml");
    await expect(blob.text()).resolves.toBe("name: Demo\n");
    expect(downloadedName).toBe("demo.yml");
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });

  it("copies the current text to the clipboard", async () => {
    const { definition } = makeServer();
    await mounted({ definition });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    await edit("name: Copied\n");
    // userEvent.setup() would install its own clipboard stub over ours.
    fireEvent.click(screen.getByTestId("copy-yaml"));

    await screen.findByText("Definition copied");
    expect(writeText).toHaveBeenCalledWith("name: Copied\n");
  });
});

describe("definition mode — leaving with unapplied changes", () => {
  it("blocks while dirty, not while clean", async () => {
    const { definition } = makeServer();
    const { router } = mountDefinition({ definition });
    await waitFor(() => expect(editor().value).toBe("name: Demo\n"));

    // Clean: navigation goes through.
    void router.navigate({ to: "/other" as never });
    await screen.findByTestId("other-page");
    void router.navigate({ to: "/" });
    await waitFor(() => expect(editor().value).toBe("name: Demo\n"));

    // Dirty: blocked with a confirmation.
    await edit("name: Staying\n");
    void router.navigate({ to: "/other" as never });
    await screen.findByTestId("definition-blocker");
    expect(screen.queryByTestId("other-page")).toBeNull();

    await userEvent.setup().click(screen.getByTestId("definition-blocker-stay"));
    await waitFor(() => expect(screen.queryByTestId("definition-blocker")).toBeNull());
    expect(screen.getByTestId("definition-editor")).toBeInTheDocument();

    void router.navigate({ to: "/other" as never });
    await screen.findByTestId("definition-blocker");
    await userEvent.setup().click(screen.getByTestId("definition-blocker-leave"));
    await screen.findByTestId("other-page");
  });
});

describe("definition mode — live updates", () => {
  it("silently re-exports while clean", async () => {
    const { server, definition } = makeServer();
    const { live, push } = pushableLive();
    mountDefinition({ definition, live }, { withLive: true });
    await waitFor(() => expect(editor().value).toBe("name: Demo\n"));

    server.exported = create(ExportDefinitionResponseSchema, {
      yaml: "name: Newer\n",
      fingerprint: "fp-2",
      filename: "demo.yml",
    });
    push(EventType.WORKFLOW_UPDATED);

    await waitFor(() => expect(editor().value).toBe("name: Newer\n"));
    expect(screen.queryByTestId("definition-changed-elsewhere")).toBeNull();
    expect(screen.getByTestId("definition-dirty")).toHaveTextContent("Clean");
  });

  it("warns while dirty; Review opens the conflict diff", async () => {
    const { server, definition } = makeServer();
    const { live, push } = pushableLive();
    mountDefinition({ definition, live }, { withLive: true });
    await waitFor(() => expect(editor().value).toBe("name: Demo\n"));
    await edit("name: Mine\n");

    server.exported = create(ExportDefinitionResponseSchema, {
      yaml: "name: Theirs\n",
      fingerprint: "fp-theirs",
      filename: "demo.yml",
    });
    push(EventType.WORKFLOW_UPDATED);

    await screen.findByTestId("definition-changed-elsewhere");
    expect(editor().value).toBe("name: Mine\n"); // never clobbered
    await userEvent.setup().click(screen.getByTestId("definition-review"));
    await screen.findByTestId("definition-conflict");
    expect(screen.getByTestId("yaml-diff")).toHaveAttribute("data-original", "name: Theirs\n");
  });
});
