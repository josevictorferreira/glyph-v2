// Step editor tab tests (spec 0018 tasks 2–6): each field calls the right
// RPC with the grouped payload; prompt autocomplete and chips; model picker
// with an unavailable current model, temperature gating and stale refresh;
// source picker connect / map / replace / cycle guard.
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { OutputFileFormat, StepKind, WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import type { Issue } from "@/gen/glyph/v1/common_pb";
import { WorkflowSchema } from "@/gen/glyph/v1/workflow_pb";
import type { Workflow } from "@/gen/glyph/v1/workflow_pb";
import { useWorkflow } from "@/features/workflows";
import { renderWithApp } from "@test/render";
import type { StepEditorTab } from "./chrome";
import { StepEditor } from "./StepEditor";

const baseWorkflow = create(WorkflowSchema, {
  summary: { id: "wf-1", name: "Digest", status: WorkflowStatus.DRAFT },
  inputs: [{ id: "wi-1", name: "topic", askAtRunTime: true, required: true }],
  steps: [
    { id: "s1", kind: StepKind.PI, name: "Research", outputName: "notes" },
    {
      id: "s2",
      kind: StepKind.PI,
      name: "Writer",
      prompt: "Write about {{topic}} {{ghost}}",
      outputName: "draft",
      modelId: "velox/old-model",
      outputFileFormat: OutputFileFormat.FREE_TEXT_MARKDOWN,
      inputs: [
        { id: "si-1", name: "notes", required: true, incomingConnectionId: "c1" },
        { id: "si-2", name: "style", required: false },
      ],
    },
    {
      id: "s3",
      kind: StepKind.PI,
      name: "Reviewer",
      outputName: "review",
      inputs: [{ id: "si-3", name: "draft" }],
    },
  ],
  connections: [
    {
      id: "c1",
      sourceStepId: "s1",
      sourceOutputName: "notes",
      destinationStepId: "s2",
      destinationInputId: "si-1",
    },
    {
      id: "c2",
      sourceStepId: "s2",
      sourceOutputName: "draft",
      destinationStepId: "s3",
      destinationInputId: "si-3",
    },
  ],
});

type Calls = Record<string, Array<Record<string, unknown>>>;

function mount(tab: StepEditorTab, opts: { issues?: Issue[] } = {}) {
  const calls: Calls = {};
  const workflow: Workflow = baseWorkflow;
  const record = (name: string) => async (req: object) => {
    (calls[name] ??= []).push(req as Record<string, unknown>);
    return { workflow, issues: opts.issues ?? [] };
  };
  const services = {
    workflow: {
      getWorkflow: async () => ({ workflow, issues: opts.issues ?? [] }),
      updateStepPrompt: record("updateStepPrompt"),
      updateStepModel: record("updateStepModel"),
      toggleStepTool: record("toggleStepTool"),
      updateStepOutput: record("updateStepOutput"),
      updateStepDetails: record("updateStepDetails"),
      createConnection: record("createConnection"),
      mapStepInput: record("mapStepInput"),
      removeConnection: record("removeConnection"),
      addStepInput: record("addStepInput"),
    },
    catalog: {
      listModels: async () => ({
        stale: true,
        models: [
          {
            provider: "velox",
            modelId: "glm-5-3",
            fullId: "velox/glm-5-3",
            displayName: "GLM 5.3",
            available: true,
            capabilities: { temperature: true },
          },
          {
            provider: "velox",
            modelId: "old-model",
            fullId: "velox/old-model",
            displayName: "Old model",
            available: false,
          },
        ],
      }),
      listTools: async () => ({
        tools: [
          {
            key: "web_search",
            displayName: "Web search",
            description: "Search the web.",
            enabled: true,
          },
        ],
      }),
      refreshModels: async () => {
        (calls.refreshModels ??= []).push({});
        return { results: [] };
      },
    },
  };
  renderWithApp(<Harness initialTab={tab} />, { services: services as never });
  return { calls };
}

function Harness({ initialTab }: { initialTab: StepEditorTab }) {
  const { data } = useWorkflow("wf-1");
  const [tab, setTab] = useState(initialTab);
  const workflow = data?.workflow;
  const step = workflow?.steps.find((s) => s.id === "s2");
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

describe("Instructions tab", () => {
  it("autocompletes {{ with the step's inputs and workflow values", async () => {
    const { calls } = mount("instructions");
    const prompt = await screen.findByRole("combobox", { name: "Prompt" });
    await userEvent.click(prompt);
    await userEvent.type(prompt, " {{{{st");
    const list = screen.getByRole("listbox", { name: "Variables" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["styleInput"]);
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(calls.updateStepPrompt?.at(-1)).toMatchObject({
        stepId: "s2",
        prompt: "Write about {{topic}} {{ghost}} {{style}}",
      }),
    );
  });

  it("marks unknown tokens and inserts variables from chips", async () => {
    const { calls } = mount("instructions");
    await screen.findByRole("combobox", { name: "Prompt" });
    expect(document.querySelector('mark[data-token="ghost"]')).toHaveAttribute(
      "data-known",
      "false",
    );
    expect(document.querySelector('mark[data-token="topic"]')).toHaveAttribute(
      "data-known",
      "true",
    );
    const chips = screen.getByRole("group", { name: "Insert a variable into Prompt" });
    await userEvent.click(within(chips).getByRole("button", { name: "{{notes}}" }));
    await waitFor(() =>
      expect(calls.updateStepPrompt?.at(-1)?.prompt).toBe(
        "Write about {{topic}} {{ghost}}{{notes}}",
      ),
    );
  });

  it("shows the validator message under the prompt", async () => {
    mount("instructions", {
      issues: [
        {
          entityType: 2,
          entityId: "s2",
          field: "prompt",
          message:
            "“Writer” uses “{{ghost}}” but no workflow value or input provides it. Add one or fix the spelling.",
        } as unknown as Issue,
      ],
    });
    expect(await screen.findByText(/uses “\{\{ghost\}\}” but no workflow value/)).toBeVisible();
  });
});

describe("Model & tools tab", () => {
  it("keeps an unavailable current model visible and gates temperature on capability", async () => {
    const { calls } = mount("model");
    const picker = await screen.findByRole("button", { name: "Model" });
    await waitFor(() => expect(picker).toHaveTextContent("Old model"));
    expect(screen.queryByLabelText("Temperature")).toBeNull();

    await userEvent.click(picker);
    expect(screen.getByText("Unavailable")).toBeVisible();
    await userEvent.click(screen.getByRole("option", { name: /GLM 5\.3/ }));
    expect(await screen.findByLabelText("Temperature")).toBeVisible();
    await waitFor(() =>
      expect(calls.updateStepModel?.at(-1)).toMatchObject({
        stepId: "s2",
        modelId: "velox/glm-5-3",
      }),
    );
  });

  it("offers a refresh when the catalog is stale", async () => {
    const { calls } = mount("model");
    await userEvent.click(await screen.findByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls.refreshModels).toHaveLength(1));
  });

  it("toggles tools through ToggleStepTool", async () => {
    const { calls } = mount("model");
    await userEvent.click(await screen.findByRole("checkbox", { name: /Web search/ }));
    await waitFor(() =>
      expect(calls.toggleStepTool?.[0]).toMatchObject({ stepId: "s2", toolKey: "web_search" }),
    );
  });
});

describe("Output tab", () => {
  it("saves name, format and expected output together", async () => {
    const { calls } = mount("output");
    await userEvent.click(await screen.findByRole("radio", { name: "JSON" }));
    await waitFor(() =>
      expect(calls.updateStepOutput?.at(-1)).toMatchObject({
        stepId: "s2",
        outputName: "draft",
        outputFileFormat: OutputFileFormat.JSON,
      }),
    );
  });

  it("warns that renaming updates downstream connections", async () => {
    mount("output");
    const name = await screen.findByLabelText("Output name");
    await userEvent.type(name, "s");
    expect(screen.getByText("Updates 1 connection.")).toBeVisible();
  });
});

describe("Settings tab", () => {
  it("saves allow failure with the step's name", async () => {
    const { calls } = mount("settings");
    await userEvent.click(await screen.findByRole("switch", { name: "Allow failure" }));
    await waitFor(() =>
      expect(calls.updateStepDetails?.at(-1)).toMatchObject({
        stepId: "s2",
        name: "Writer",
        allowFailure: true,
      }),
    );
  });
});

describe("Inputs tab", () => {
  it("maps an unconnected input to a workflow value and guards cycles", async () => {
    const { calls } = mount("inputs");
    await userEvent.click(await screen.findByRole("button", { name: "Source for style" }));
    expect(screen.getByRole("option", { name: /Output of Reviewer/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await userEvent.click(screen.getByRole("option", { name: /Workflow value topic/ }));
    await waitFor(() =>
      expect(calls.mapStepInput?.[0]).toMatchObject({ inputId: "si-2", workflowInputId: "wi-1" }),
    );
  });

  it("connects an input to an upstream step output", async () => {
    const { calls } = mount("inputs");
    await userEvent.click(await screen.findByRole("button", { name: "Source for style" }));
    await userEvent.click(screen.getByRole("option", { name: /Output of Research/ }));
    await waitFor(() =>
      expect(calls.createConnection?.[0]).toMatchObject({
        sourceStepId: "s1",
        destinationInputId: "si-2",
        replaceExisting: false,
      }),
    );
  });

  it("asks inline before replacing a connection with a workflow value", async () => {
    const { calls } = mount("inputs");
    await userEvent.click(await screen.findByRole("button", { name: "Source for notes" }));
    await userEvent.click(screen.getByRole("option", { name: /Workflow value topic/ }));
    const confirm = screen.getByRole("group", { name: "Confirm replace" });
    expect(calls.removeConnection).toBeUndefined();
    await userEvent.click(within(confirm).getByRole("button", { name: "Replace" }));
    await waitFor(() =>
      expect(calls.mapStepInput?.[0]).toMatchObject({ inputId: "si-1", workflowInputId: "wi-1" }),
    );
    expect(calls.removeConnection?.[0]).toMatchObject({ connectionId: "c1" });
  });

  it("adds an input", async () => {
    const { calls } = mount("inputs");
    await userEvent.type(await screen.findByLabelText("New input name"), "tone");
    await userEvent.click(screen.getByRole("button", { name: "Add input" }));
    await waitFor(() =>
      expect(calls.addStepInput?.[0]).toMatchObject({ stepId: "s2", name: "tone", required: true }),
    );
  });
});
