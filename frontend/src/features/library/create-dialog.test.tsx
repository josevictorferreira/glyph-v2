// Create dialog tests (spec 0016 task 4), in route mode so navigation after
// create/import works: YAML dry-run errors with line numbers, import gating,
// duplicate via export → strip ids → rename → import.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import {
  ExportDefinitionResponseSchema,
  ImportWorkflowResponseSchema,
  ParseDefinitionResponseSchema,
} from "@/gen/glyph/v1/definition_pb";
import {
  GetWorkflowResponseSchema,
  ListWorkflowsResponseSchema,
  WorkflowSummarySchema,
} from "@/gen/glyph/v1/workflow_pb";
import { renderWithApp } from "@test/render";

// The import dialog uses the shared Monaco editor (spec 0021 task 6); in
// jsdom it is stubbed with a plain controlled textarea.
vi.mock("@/features/definition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/definition")>();
  return {
    ...actual,
    YamlEditor: (props: {
      value: string;
      "data-testid"?: string;
      onChange?: (value: string) => void;
    }) => (
      <textarea
        data-testid={props["data-testid"] ?? "create-yaml"}
        value={props.value}
        onChange={(e) => props.onChange?.(e.target.value)}
      />
    ),
  };
});

afterEach(() => vi.restoreAllMocks());

const ts = (iso: string) =>
  create(TimestampSchema, { seconds: BigInt(Date.parse(iso) / 1000), nanos: 0 });
const idleLive = {
  watchWorkflow: async function* () {
    await new Promise(() => {});
  },
};

const baseWorkflow = {
  listWorkflows: () => Promise.resolve(create(ListWorkflowsResponseSchema, { workflows: [] })),
  getWorkflow: () => Promise.resolve(create(GetWorkflowResponseSchema, {})),
};

async function openOnTab(tabName: string) {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("library-new"));
  await screen.findByTestId("create-dialog");
  await user.click(screen.getByRole("tab", { name: tabName }));
}

describe("create dialog — from YAML", () => {
  it("shows dry-run errors with line numbers and blocks import", async () => {
    const parsed: string[] = [];
    const { unmount } = renderWithApp(undefined, {
      route: "/",
      services: {
        workflow: baseWorkflow,
        definition: {
          parseDefinition: (req: { yaml: string }) => {
            parsed.push(req.yaml);
            return Promise.resolve(
              create(ParseDefinitionResponseSchema, {
                errors: [
                  { line: 3, message: "steps[0].prompt: is required" },
                  { message: "unknown field: turbo" },
                ],
              }),
            );
          },
        },
        live: idleLive,
      },
    });
    await screen.findByTestId("library-new");
    await openOnTab("From YAML");
    const box = screen.getByTestId("create-yaml");
    vi.useFakeTimers();
    try {
      fireEvent.change(box, { target: { value: "name: x\nsteps:\n  - name: A\n" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(parsed).toEqual(["name: x\nsteps:\n  - name: A\n"]);
      const errors = screen.getByTestId("yaml-errors");
      expect(errors.textContent).toContain("Line 3: steps[0].prompt: is required");
      expect(errors.textContent).toContain("unknown field: turbo");
      expect(screen.getByTestId("import-submit")).toBeDisabled();
    } finally {
      vi.useRealTimers();
      unmount();
    }
  });

  it("imports when the document is valid and navigates", async () => {
    const imported: string[] = [];
    const { unmount, router } = renderWithApp(undefined, {
      route: "/",
      services: {
        workflow: baseWorkflow,
        definition: {
          parseDefinition: () =>
            Promise.resolve(create(ParseDefinitionResponseSchema, { errors: [] })),
          importWorkflow: (req: { yaml: string }) => {
            imported.push(req.yaml);
            return Promise.resolve(
              create(ImportWorkflowResponseSchema, {
                workflow: { summary: { id: "wf-imported", name: "Imported" } },
                issues: [],
              }),
            );
          },
        },
        live: idleLive,
      },
    });
    await screen.findByTestId("library-new");
    await openOnTab("From YAML");
    fireEvent.change(screen.getByTestId("create-yaml"), { target: { value: "name: Imported\n" } });
    await waitFor(() => expect(screen.getByTestId("yaml-valid")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("import-submit"));
    await waitFor(() => expect(imported).toEqual(["name: Imported\n"]));
    await waitFor(() => expect(router?.state.location.pathname).toBe("/workflows/wf-imported"));
    unmount();
  });
});

describe("create dialog — duplicate", () => {
  it("strips step ids and renames the copy", async () => {
    const exportedYaml = `# comment kept\nname: Original\nsteps:\n  - id: step-1\n    name: Research\n    kind: pi\n  - id: step-2\n    name: Write\n    kind: helper\n`;
    const imported: string[] = [];
    const { unmount } = renderWithApp(undefined, {
      route: "/",
      services: {
        workflow: {
          listWorkflows: () =>
            Promise.resolve(
              create(ListWorkflowsResponseSchema, {
                workflows: [
                  create(WorkflowSummarySchema, {
                    id: "wf-1",
                    name: "Original",
                    status: WorkflowStatus.DRAFT,
                    updatedAt: ts("2026-01-15T10:00:00Z"),
                  }),
                ],
              }),
            ),
          getWorkflow: baseWorkflow.getWorkflow,
        },
        definition: {
          exportDefinition: () =>
            Promise.resolve(
              create(ExportDefinitionResponseSchema, {
                yaml: exportedYaml,
                fingerprint: "f",
                filename: "original.yml",
              }),
            ),
          importWorkflow: (req: { yaml: string }) => {
            imported.push(req.yaml);
            return Promise.resolve(
              create(ImportWorkflowResponseSchema, {
                workflow: { summary: { id: "wf-copy", name: "Original (copy)" } },
                issues: [],
              }),
            );
          },
        },
        live: idleLive,
      },
    });
    await screen.findByTestId("library-row-wf-1");
    await openOnTab("Duplicate");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Workflow to copy" }));
    const option = await screen.findByRole("option", { name: /Original/ });
    await user.click(option);
    await waitFor(() => expect(screen.getByTestId("duplicate-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("duplicate-submit"));
    await waitFor(() => expect(imported).toHaveLength(1));
    expect(imported[0]).toContain("name: Original (copy)");
    expect(imported[0]).not.toContain("id: step-1");
    expect(imported[0]).not.toContain("id: step-2");
    expect(imported[0]).toContain("# comment kept");
    expect(imported[0]).toContain("name: Research");
    unmount();
  });
});
