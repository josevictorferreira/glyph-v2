// Step run panel tests (spec 0020 tasks 5–8): error + retry gating, resolved
// input source links, output renderers per format (sanitized Markdown,
// sandboxed HTML, JSON tree, ZIP download), transcript pin behaviour and the
// configuration used section.
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { create, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { OutputFileFormat, RunStatus, StepKind, StepRunStatus } from "@/gen/glyph/v1/common_pb";
import {
  InputSourceKind,
  RunSchema,
  StepRunSchema,
  TranscriptBlockSchema,
} from "@/gen/glyph/v1/run_pb";
import type { RetryStepRequest, StepRun } from "@/gen/glyph/v1/run_pb";
import { renderWithApp } from "@test/render";
import { StepOutput } from "./OutputView";
import { StepRunPanel, Transcript } from "./StepRunPanel";

function stepRun(overrides: Partial<StepRun> = {}, summary: Record<string, unknown> = {}): StepRun {
  return create(StepRunSchema, {
    summary: {
      id: "sr-1",
      snapshotStepId: "ss-1",
      stepName: "Research",
      stepKind: StepKind.PI,
      status: StepRunStatus.SUCCEEDED,
      hasOutput: true,
      outputName: "notes",
      outputFileFormat: OutputFileFormat.FREE_TEXT_MARKDOWN,
      ...summary,
    },
    downloadPath: "/workflows/wf/runs/r/step_runs/sr-1/download",
    ...overrides,
  } as never);
}

function mountPanel(sr: StepRun, runStatus = RunStatus.FAILED, onSelect = vi.fn()) {
  const retries: RetryStepRequest[] = [];
  const run = create(RunSchema, { id: "r", workflowId: "wf", status: runStatus });
  renderWithApp(
    <StepRunPanel workflowId="wf" run={run} stepRunId="sr-1" onSelectStepRun={onSelect} />,
    {
      services: {
        run: {
          getStepRun: async () => ({ stepRun: sr }),
          retryStep: async (req: RetryStepRequest) => {
            retries.push(req);
            return { run };
          },
        },
      },
    },
  );
  return { retries, onSelect };
}

describe("StepRunPanel", () => {
  it("shows the human error, technical detail, and retries a failed step of a finished run", async () => {
    const { retries } = mountPanel(
      stepRun(
        { technicalError: "exit status 1" },
        { status: StepRunStatus.FAILED, humanError: "The model is unavailable.", hasOutput: false },
      ),
    );
    expect(await screen.findByText("The model is unavailable.")).toBeVisible();
    expect(screen.getByText("Technical detail")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry step" }));
    await waitFor(() => expect(retries[0]).toMatchObject({ runId: "r", stepRunId: "sr-1" }));
  });

  it("disables retry while the run is still live", async () => {
    mountPanel(
      stepRun({}, { status: StepRunStatus.FAILED, humanError: "boom" }),
      RunStatus.RUNNING,
    );
    expect(await screen.findByRole("button", { name: "Retry step" })).toBeDisabled();
  });

  it("links an input to the step run that produced it", async () => {
    const { onSelect } = mountPanel(
      stepRun({
        resolvedInputs: [
          {
            name: "notes",
            value: fromJson(ValueSchema, "upstream text"),
            source: {
              kind: InputSourceKind.STEP_OUTPUT,
              stepRunId: "sr-0",
              label: "Output from Research",
            },
          },
        ],
      } as never),
      RunStatus.SUCCEEDED,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Output from Research" }));
    expect(onSelect).toHaveBeenCalledWith("sr-0");
    expect(screen.getByText("upstream text")).toBeVisible();
  });

  it("shows the configuration used from the step run", async () => {
    mountPanel(
      stepRun({
        prompt: "Research {{topic}}",
        modelId: "velox/glm-5-3",
        enabledToolNames: ["web_search"],
      }),
      RunStatus.SUCCEEDED,
    );
    const config = await screen.findByTestId("configuration-used");
    expect(config).toHaveTextContent("Research {{topic}}");
    expect(config).toHaveTextContent("velox/glm-5-3");
    expect(config).toHaveTextContent("web_search");
  });
});

describe("StepOutput", () => {
  it("renders Markdown with scripts stripped", () => {
    render(
      <StepOutput
        stepRun={stepRun({ outputText: "# Title\n\n<script>alert(1)</script>\n\n**bold**" })}
      />,
    );
    expect(screen.getByRole("heading", { name: "Title" })).toBeVisible();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
  });

  it("previews HTML in a sandboxed iframe from the preview route", () => {
    render(
      <StepOutput
        stepRun={stepRun(
          { outputText: "<h1>Hi</h1>", previewPath: "/workflows/wf/runs/r/step_runs/sr-1/preview" },
          { outputFileFormat: OutputFileFormat.HTML },
        )}
      />,
    );
    const frame = screen.getByTitle("Research output preview");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame).toHaveAttribute("src", "/workflows/wf/runs/r/step_runs/sr-1/preview");
    expect(screen.getByRole("link", { name: "Open in new tab" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
  });

  it("shows JSON output as a tree", () => {
    render(
      <StepOutput
        stepRun={stepRun(
          { outputJson: fromJson(ValueSchema, { score: 3, tags: ["a"] }) },
          { outputFileFormat: OutputFileFormat.JSON },
        )}
      />,
    );
    expect(screen.getByText("score:")).toBeVisible();
    expect(screen.getByText("3")).toBeVisible();
  });

  it("offers ZIP output as a download only", () => {
    render(<StepOutput stepRun={stepRun({}, { outputFileFormat: OutputFileFormat.ZIP })} />);
    expect(screen.getByText("notes.zip")).toBeVisible();
    expect(screen.getByRole("link", { name: /Download/ })).toHaveAttribute(
      "href",
      "/workflows/wf/runs/r/step_runs/sr-1/download",
    );
    expect(screen.queryByRole("button", { name: "Raw" })).toBeNull();
  });
});

describe("Transcript", () => {
  const blocks = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      create(TranscriptBlockSchema, { block: { case: "text", value: { text: `Block ${i}` } } }),
    );

  function geometry(el: HTMLElement, scrollTop: number) {
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 200 });
    el.scrollTop = scrollTop;
  }

  it("follows new blocks while pinned and offers Jump to latest after scrolling up", () => {
    const { rerender } = render(<Transcript blocks={blocks(2)} live />);
    const box = screen.getByTestId("transcript");
    geometry(box, 800);
    fireEvent.scroll(box);
    rerender(<Transcript blocks={blocks(3)} live />);
    expect(box.scrollTop).toBe(1000); // pinned: followed to the bottom
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();

    geometry(box, 100); // reader scrolled up
    fireEvent.scroll(box);
    rerender(<Transcript blocks={blocks(4)} live />);
    expect(box.scrollTop).toBe(100); // not yanked down
    const jump = screen.getByRole("button", { name: "Jump to latest" });
    act(() => jump.click());
    expect(box.scrollTop).toBe(1000);
  });

  it("renders tool calls as rows", () => {
    render(
      <Transcript
        blocks={[
          create(TranscriptBlockSchema, {
            block: { case: "tool", value: { name: "bash", summary: "ls -la", state: 2 } },
          }),
        ]}
        live={false}
      />,
    );
    expect(screen.getByTestId("transcript-tool")).toHaveTextContent("bash");
    expect(screen.getByTestId("transcript-tool")).toHaveTextContent("ls -la");
  });
});
