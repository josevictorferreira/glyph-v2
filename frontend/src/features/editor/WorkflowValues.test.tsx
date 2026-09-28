// Workflow values tests (spec 0018 task 7): add asked/constant values,
// client-side name rule, grouped autosave, usage count and remove confirm.
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { StepKind, WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import { WorkflowSchema } from "@/gen/glyph/v1/workflow_pb";
import { renderWithApp } from "@test/render";
import { NAME_RULE, WorkflowValues } from "./WorkflowValues";

const workflow = create(WorkflowSchema, {
  summary: { id: "wf-1", name: "Digest", status: WorkflowStatus.DRAFT },
  inputs: [{ id: "wi-1", name: "topic", askAtRunTime: true, required: true }],
  steps: [
    { id: "s1", kind: StepKind.PI, name: "Research", prompt: "About {{topic}}" },
    {
      id: "s2",
      kind: StepKind.PI,
      name: "Writer",
      inputs: [{ id: "si-1", name: "subject", workflowInputId: "wi-1" }],
    },
    { id: "s3", kind: StepKind.PI, name: "Reviewer" },
  ],
});

function mount() {
  const calls: Record<string, Array<Record<string, unknown>>> = {};
  const record = (name: string) => async (req: object) => {
    (calls[name] ??= []).push(req as Record<string, unknown>);
    return { workflow, issues: [] };
  };
  renderWithApp(<WorkflowValues workflow={workflow} />, {
    services: {
      workflow: {
        getWorkflow: async () => ({ workflow, issues: [] }),
        addWorkflowInput: record("addWorkflowInput"),
        updateWorkflowInput: record("updateWorkflowInput"),
        removeWorkflowInput: record("removeWorkflowInput"),
      } as never,
    },
  });
  return { calls };
}

describe("WorkflowValues (spec 0018)", () => {
  it("counts steps that map or reference a value", () => {
    mount();
    expect(screen.getByText("Used by 2 steps")).toBeVisible();
  });

  it("adds a constant with its value", async () => {
    const { calls } = mount();
    await userEvent.type(screen.getByLabelText("New value name"), "tone");
    await userEvent.click(screen.getByRole("combobox", { name: "New value kind" }));
    await userEvent.click(await screen.findByRole("option", { name: "Constant" }));
    await userEvent.type(screen.getByLabelText("New value"), "friendly");
    await userEvent.click(screen.getByRole("button", { name: "Add value" }));
    await waitFor(() =>
      expect(calls.addWorkflowInput?.[0]).toMatchObject({
        workflowId: "wf-1",
        name: "tone",
        askAtRunTime: false,
        required: true,
        value: "friendly",
      }),
    );
  });

  it("checks the name rule before calling the backend", async () => {
    const { calls } = mount();
    await userEvent.type(screen.getByLabelText("New value name"), "1st");
    expect(screen.getByText(NAME_RULE)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Add value" }));
    expect(calls.addWorkflowInput).toBeUndefined();
  });

  it("autosaves row edits as one UpdateWorkflowInput payload", async () => {
    const { calls } = mount();
    await userEvent.type(screen.getByLabelText("Default"), "rust");
    await waitFor(() =>
      expect(calls.updateWorkflowInput?.at(-1)).toMatchObject({
        inputId: "wi-1",
        name: "topic",
        value: "rust",
        askAtRunTime: true,
        required: true,
      }),
    );
  });

  it("confirms removal and lists the affected steps", async () => {
    const { calls } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Remove value topic" }));
    expect(
      screen.getByText("Used by Research, Writer. Their inputs lose this source."),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls.removeWorkflowInput?.[0]).toMatchObject({ inputId: "wi-1" }));
  });
});
