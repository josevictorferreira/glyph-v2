// ScheduledValues tests (spec 0019 task 5): rows for asked / required-empty
// inputs, autosave through SetScheduleValue, validator copy while missing.
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create } from "@bufbuild/protobuf";
import { WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import {
  GetWorkflowResponseSchema,
  ScheduleSchema,
  ScheduleValueSchema,
  SetScheduleValueResponseSchema,
  WorkflowSchema,
} from "@/gen/glyph/v1/workflow_pb";
import type { SetScheduleValueRequest, Workflow } from "@/gen/glyph/v1/workflow_pb";
import { renderWithApp } from "@test/render";
import { ScheduledValues } from "./ScheduleValues";

const schedule = create(ScheduleSchema, {
  id: "sch-1",
  enabled: true,
  cronExpression: "0 9 * * 1",
  timezone: "UTC",
  values: [{ workflowInputId: "in-asked", value: "stored topic" }],
});

function wf(inputs: Parameters<typeof makeInputs>[0]): Workflow {
  return create(WorkflowSchema, {
    summary: { id: "wf-1", name: "Tournament", status: WorkflowStatus.ACTIVE },
    inputs,
    schedule,
  });
}

function makeInputs(
  init: Array<{
    id: string;
    name: string;
    required?: boolean;
    askAtRunTime?: boolean;
    value?: string;
  }>,
) {
  return init;
}

function mount(inputs: Parameters<typeof makeInputs>[0]) {
  const requests: SetScheduleValueRequest[] = [];
  let current = wf(inputs);
  renderWithApp(<ScheduledValues workflow={current} />, {
    services: {
      workflow: {
        getWorkflow: async () => create(GetWorkflowResponseSchema, { workflow: current }),
        setScheduleValue: async (req: SetScheduleValueRequest) => {
          requests.push(req);
          // Echo the stored value back on the schedule (server behaviour).
          current = create(WorkflowSchema, {
            ...current,
            schedule: create(ScheduleSchema, {
              ...schedule,
              values: [
                ...schedule.values.filter((v) => v.workflowInputId !== req.workflowInputId),
                create(ScheduleValueSchema, {
                  workflowInputId: req.workflowInputId,
                  value: req.value,
                }),
              ],
            }),
          });
          return create(SetScheduleValueResponseSchema, { workflow: current, issues: [] });
        },
      },
    },
  });
  return { requests };
}

describe("ScheduledValues (spec 0019)", () => {
  it("lists asked and required-but-empty inputs, not constants", () => {
    mount(
      makeInputs([
        { id: "in-asked", name: "Topic", required: true, askAtRunTime: true },
        { id: "in-empty", name: "Depth", required: true, askAtRunTime: false },
        { id: "in-const", name: "Style", required: false, askAtRunTime: false, value: "concise" },
      ]),
    );
    expect(screen.getByTestId("schedule-values")).toBeVisible();
    expect(screen.getByLabelText("Value for scheduled runs: Topic")).toHaveValue("stored topic");
    expect(screen.getByLabelText("Value for scheduled runs: Depth")).toBeInTheDocument();
    expect(screen.queryByLabelText("Value for scheduled runs: Style")).toBeNull();
  });

  it("autosaves edits through SetScheduleValue", async () => {
    const { requests } = mount(makeInputs([{ id: "in-empty", name: "Depth", required: true }]));
    const field = screen.getByLabelText("Value for scheduled runs: Depth");
    await userEvent.type(field, "deep");
    await waitFor(() => expect(requests.at(-1)?.value).toBe("deep"));
    expect(requests.at(-1)?.workflowInputId).toBe("in-empty");
  });

  it("flags missing required values with the validator message", () => {
    mount(makeInputs([{ id: "in-empty", name: "Depth", required: true }]));
    expect(
      screen.getByText("The schedule needs a value for the required workflow input “Depth”."),
    ).toBeVisible();
  });

  it("renders nothing without a schedule or without relevant inputs", () => {
    renderWithApp(
      <ScheduledValues
        workflow={create(WorkflowSchema, {
          summary: { id: "wf-1", status: WorkflowStatus.ACTIVE },
        })}
      />,
      {},
    );
    expect(screen.queryByTestId("schedule-values")).toBeNull();
  });
});
