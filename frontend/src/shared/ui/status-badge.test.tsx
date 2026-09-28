import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { RunStatusBadge, StatusBadge, StepRunStatusBadge, WorkflowStatusBadge } from "./badge";
import {
  describeRunStatus,
  describeStepRunStatus,
  describeWorkflowStatus,
} from "@/shared/api/enums";
import { RunStatus, StepRunStatus, WorkflowStatus } from "@/gen/glyph/v1/common_pb";
import { renderWithApp } from "@test/render";

// StatusBadge exhaustiveness (0014 task 4): every proto status maps to a label.
describe("StatusBadge", () => {
  it("renders a label for every WorkflowStatus", () => {
    for (const value of Object.values(WorkflowStatus).filter(
      (v): v is WorkflowStatus => typeof v === "number",
    )) {
      if (value === WorkflowStatus.UNSPECIFIED) continue;
      const view = describeWorkflowStatus(value);
      const { unmount } = renderWithApp(<WorkflowStatusBadge status={value} />);
      expect(screen.getByText(view.label)).toBeInTheDocument();
      unmount();
    }
  });

  it("renders a label for every RunStatus", () => {
    for (const value of Object.values(RunStatus).filter(
      (v): v is RunStatus => typeof v === "number",
    )) {
      if (value === RunStatus.UNSPECIFIED) continue;
      const view = describeRunStatus(value);
      const { unmount } = renderWithApp(<RunStatusBadge status={value} />);
      expect(screen.getByText(view.label)).toBeInTheDocument();
      unmount();
    }
  });

  it("renders a label for every StepRunStatus", () => {
    for (const value of Object.values(StepRunStatus).filter(
      (v): v is StepRunStatus => typeof v === "number",
    )) {
      if (value === StepRunStatus.UNSPECIFIED) continue;
      const view = describeStepRunStatus(value);
      const { unmount } = renderWithApp(<StepRunStatusBadge status={value} />);
      expect(screen.getByText(view.label)).toBeInTheDocument();
      unmount();
    }
  });

  it("renders Unknown for unspecified values", () => {
    renderWithApp(<WorkflowStatusBadge status={WorkflowStatus.UNSPECIFIED} />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("applies tone classes", () => {
    renderWithApp(<StatusBadge view={{ label: "Failed", tone: "danger" }} />);
    const el = screen.getByText("Failed");
    expect(el.className).toMatch(/status-failed/);
  });
});
