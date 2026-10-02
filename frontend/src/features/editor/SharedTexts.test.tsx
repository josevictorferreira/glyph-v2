// Shared texts tests (spec 0023): the picker links and detaches through
// SetStepTextRef, the vars form renders one row per token with fallback
// labels and saves the whole map, "Make shared" pre-fills the key and calls
// ExtractSharedText, the panel disables remove while a text is in use, and a
// linked field never rides along in the plain autosave.
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { OutputFileFormat, StepKind, WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import { TextField } from "@/gen/glyph/v1/workflow_pb";
import { WorkflowSchema } from "@/gen/glyph/v1/workflow_pb";
import type { Workflow } from "@/gen/glyph/v1/workflow_pb";
import { useWorkflow } from "@/features/workflows";
import { renderWithApp } from "@test/render";
import type { StepEditorTab } from "./chrome";
import { EditorChromeProvider } from "./chrome";
import { StepEditor } from "./StepEditor";
import { WorkflowPanel } from "./WorkflowPanel";

// s2's prompt is linked to t-1 (vars: topic), s4 keeps its own prompt.
const baseWorkflow = create(WorkflowSchema, {
  summary: { id: "wf-1", name: "Digest", status: WorkflowStatus.DRAFT },
  inputs: [{ id: "wi-1", name: "topic", askAtRunTime: true, required: true }],
  texts: [
    {
      id: "t-1",
      key: "designer_brief",
      body: "Design for {{topic}}, {{style}} and {{ghost}}.",
      position: 0,
    },
    { id: "t-2", key: "unused_text", body: "Nowhere used.", position: 1 },
  ],
  steps: [
    {
      id: "s2",
      kind: StepKind.PI,
      name: "Writer",
      // The server-rendered effective text while linked.
      prompt: "Design for gardens, {{style}} and {{ghost}}.",
      promptRef: { textId: "t-1", vars: { topic: "gardens" } },
      outputName: "draft",
      modelId: "velox/old-model",
      outputFileFormat: OutputFileFormat.FREE_TEXT_MARKDOWN,
      inputs: [
        { id: "si-1", name: "notes", required: true, incomingConnectionId: "c1" },
        { id: "si-2", name: "style", required: false },
      ],
    },
    {
      id: "s4",
      kind: StepKind.PI,
      name: "Generate — GLM 5.3",
      prompt: "Make a design.",
      expectedOutput: "A design.",
      outputName: "design",
      modelId: "velox/glm-5-3",
      outputFileFormat: OutputFileFormat.FREE_TEXT_MARKDOWN,
    },
  ],
  connections: [],
});

type Calls = Record<string, Array<Record<string, unknown>>>;

function mountEditor(stepId: string, tab: StepEditorTab, workflow: Workflow = baseWorkflow) {
  const calls: Calls = {};
  const record = (name: string) => async (req: object) => {
    (calls[name] ??= []).push(req as Record<string, unknown>);
    return { workflow, issues: [] };
  };
  const services = {
    workflow: {
      getWorkflow: async () => ({ workflow, issues: [] }),
      updateStepPrompt: record("updateStepPrompt"),
      updateStepOutput: record("updateStepOutput"),
      setStepTextRef: record("setStepTextRef"),
      extractSharedText: record("extractSharedText"),
    },
    catalog: {
      listModels: async () => ({ stale: false, models: [] }),
      listTools: async () => ({ tools: [] }),
      refreshModels: async () => ({ results: [] }),
    },
  };
  renderWithApp(<EditorHarness initialTab={tab} stepId={stepId} />, {
    services: services as never,
  });
  return { calls };
}

function EditorHarness({ initialTab, stepId }: { initialTab: StepEditorTab; stepId: string }) {
  const { data } = useWorkflow("wf-1");
  const [tab, setTab] = useState(initialTab);
  const workflow = data?.workflow;
  const step = workflow?.steps.find((s) => s.id === stepId);
  if (!workflow || !step) return null;
  return (
    <StepEditor
      workflowId="wf-1"
      workflow={workflow}
      step={step}
      tab={tab}
      onTabChange={setTab}
      onSelectStep={() => {}}
      focus={null}
    />
  );
}

function mountPanel(workflow: Workflow = baseWorkflow) {
  const calls: Calls = {};
  const record = (name: string) => async (req: object) => {
    (calls[name] ??= []).push(req as Record<string, unknown>);
    return { workflow, issues: [] };
  };
  renderWithApp(
    <EditorChromeProvider selectStep={() => {}}>
      <WorkflowPanel workflow={workflow} focus={null} onHighlightText={() => {}} />
    </EditorChromeProvider>,
    {
      services: {
        workflow: {
          getWorkflow: async () => ({ workflow, issues: [] }),
          updateWorkflow: record("updateWorkflow"),
          addSharedText: record("addSharedText"),
          updateSharedText: record("updateSharedText"),
          removeSharedText: record("removeSharedText"),
        },
      } as never,
    },
  );
  return { calls };
}

describe("shared text picker (spec 0023)", () => {
  it("links a field through SetStepTextRef with the text id and field", async () => {
    const { calls } = mountEditor("s4", "instructions");
    await userEvent.click(
      await screen.findByRole("combobox", { name: "Use shared text for Prompt" }),
    );
    await userEvent.click(await screen.findByRole("option", { name: "designer_brief" }));
    await waitFor(() =>
      expect(calls.setStepTextRef?.[0]).toMatchObject({
        workflowId: "wf-1",
        stepId: "s4",
        field: TextField.PROMPT,
        ref: { textId: "t-1", vars: {} },
      }),
    );
  });

  it("shows the rendered preview instead of the editor and detaches", async () => {
    const { calls } = mountEditor("s2", "instructions");
    // The plain editor is gone while linked; the preview carries the field.
    await screen.findByTestId("detach-text");
    expect(screen.queryByRole("combobox", { name: "Prompt" })).toBeNull();
    const preview = document.querySelector('[data-editor-field="prompt"]');
    expect(preview).toHaveTextContent("Design for gardens");
    await userEvent.click(screen.getByTestId("detach-text"));
    await waitFor(() => {
      expect(calls.setStepTextRef?.[0]).toMatchObject({
        workflowId: "wf-1",
        stepId: "s2",
        field: TextField.PROMPT,
      });
      expect(calls.setStepTextRef?.[0]?.ref).toBeUndefined();
    });
  });

  it("never sends a linked field through the plain autosave", async () => {
    const { calls } = mountEditor("s2", "instructions");
    // The context disclosure starts collapsed: open it first.
    await userEvent.click(await screen.findByRole("button", { name: "Additional context" }));
    const context = await screen.findByRole("combobox", { name: "Additional context" });
    await userEvent.type(context, "Extra background.");
    await userEvent.click(document.body);
    await waitFor(() => {
      const last = calls.updateStepPrompt?.at(-1);
      expect(last).toMatchObject({ stepId: "s2", additionalContext: "Extra background." });
      // The linked prompt never rides along (an absent key means "keep").
      expect(last).not.toHaveProperty("prompt");
    });
  });
});

describe("vars form (spec 0023)", () => {
  it("renders one row per token, pre-filled, with fallback labels", async () => {
    mountEditor("s2", "instructions");
    const form = await screen.findByTestId("text-vars");
    expect(within(form).getByLabelText("Value for topic")).toHaveValue("gardens");
    expect(within(form).getByLabelText("Value for style")).toHaveValue("");
    expect(within(form).getByLabelText("Value for ghost")).toHaveValue("");
    // topic is a workflow value; style is one of the step's inputs; ghost is
    // neither.
    expect(within(form).getByText("falls back to workflow value `topic`")).toBeVisible();
    expect(within(form).getByText("falls back to input `style`")).toBeVisible();
    expect(within(form).getByText("unresolved")).toBeVisible();
  });

  it("saves the whole vars map on blur, omitting empty rows", async () => {
    const { calls } = mountEditor("s2", "instructions");
    await screen.findByTestId("text-vars");
    await userEvent.type(screen.getByLabelText("Value for ghost"), "fast");
    await userEvent.click(document.body);
    await waitFor(() =>
      expect(calls.setStepTextRef?.[0]).toMatchObject({
        stepId: "s2",
        field: TextField.PROMPT,
        ref: { textId: "t-1", vars: { topic: "gardens", ghost: "fast" } },
      }),
    );
  });
});

describe("make shared (spec 0023)", () => {
  it("pre-fills the key from the step name and calls ExtractSharedText", async () => {
    const { calls } = mountEditor("s4", "instructions");
    await userEvent.click(await screen.findByTestId("make-shared"));
    expect(screen.getByTestId("make-shared-key")).toHaveValue("generate_glm_5_3_prompt");
    await userEvent.click(screen.getByTestId("make-shared-confirm"));
    await waitFor(() =>
      expect(calls.extractSharedText?.[0]).toMatchObject({
        workflowId: "wf-1",
        stepId: "s4",
        field: TextField.PROMPT,
        key: "generate_glm_5_3_prompt",
      }),
    );
  });

  it("shows the backend error inline", async () => {
    const services = {
      workflow: {
        getWorkflow: async () => ({ workflow: baseWorkflow, issues: [] }),
        extractSharedText: async () => {
          throw new Error("duplicate");
        },
      },
      catalog: {
        listModels: async () => ({ stale: false, models: [] }),
        listTools: async () => ({ tools: [] }),
      },
    };
    renderWithApp(<EditorHarness initialTab="instructions" stepId="s4" />, {
      services: services as never,
    });
    await userEvent.click(await screen.findByTestId("make-shared"));
    await userEvent.click(screen.getByTestId("make-shared-confirm"));
    expect(await screen.findByRole("alert")).toBeVisible();
  });
});

describe("workflow panel shared texts (spec 0023)", () => {
  async function openSection() {
    await userEvent.click(await screen.findByRole("button", { name: "Shared texts" }));
  }

  it("disables remove while a text is in use and explains why", async () => {
    mountPanel();
    await openSection();
    const used = (await screen.findByTestId("remove-text-t-1")) as HTMLButtonElement;
    expect(used).toBeDisabled();
    expect(used).toHaveAttribute("title", "“designer_brief” is used by 1 step. Detach them first.");
    expect(screen.getByText("Used by 1 step")).toBeVisible();
    expect(screen.getByTestId("remove-text-t-2")).toBeEnabled();
    expect(screen.getByText("Unused")).toBeVisible();
  });

  it("adds a shared text with key and body", async () => {
    const { calls } = mountPanel();
    await openSection();
    await userEvent.type(await screen.findByLabelText("New text key"), "judge_prompt");
    await userEvent.type(screen.getByLabelText("New text body"), "Judge fairly.");
    await userEvent.click(screen.getByRole("button", { name: "Add text" }));
    await waitFor(() =>
      expect(calls.addSharedText?.[0]).toMatchObject({
        workflowId: "wf-1",
        key: "judge_prompt",
        body: "Judge fairly.",
      }),
    );
  });
});
