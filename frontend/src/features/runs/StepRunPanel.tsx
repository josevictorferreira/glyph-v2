// Step run panel (spec 0020): evidence for one step run, ordered for
// diagnosis — status, error (+ retry), inputs, session, output, and the
// configuration used (from the step run, i.e. the snapshot). Sections
// remember their open state per browser. Live runs refetch through the
// workspace live subscription; durations tick locally.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { StepKind, StepRunStatus } from "@/gen/glyph/v1/common_pb";
import type {
  AgentMessage,
  ResolvedInput,
  Run,
  StepRun,
  TranscriptBlock,
} from "@/gen/glyph/v1/run_pb";
import { ToolState } from "@/gen/glyph/v1/run_pb";
import { appErrorToast } from "@/shared/api/errors";
import { describeToolState } from "@/shared/api/enums";
import { formatExact, tsToDate } from "@/shared/lib/time";
import {
  Button,
  Duration,
  Skeleton,
  StatusDot,
  StepRunStatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/shared/ui";
import { useStepRun } from "./hooks";
import { isLiveRun, isLiveStepRun, looksLikeJson } from "./lib/run-view";
import { ClippedText, JsonTree, Markdown, StepOutput, valueToJson } from "./OutputView";
import { useRetryStep } from "./use-run-actions";

const SECTION_KEY = "glyph.stepRunPanel.sections";

function readSections(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(SECTION_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

function Section({
  id,
  title,
  defaultOpen,
  children,
}: {
  id: string;
  title: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readSections()[id] ?? defaultOpen);
  return (
    <details
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        try {
          localStorage.setItem(SECTION_KEY, JSON.stringify({ ...readSections(), [id]: next }));
        } catch {
          // storage unavailable: the section just won't be remembered
        }
      }}
      className="border-b border-border px-3 py-2"
      data-testid={`section-${id}`}
    >
      <summary className="cursor-pointer select-none py-1 text-sm font-medium text-ink">
        {title}
      </summary>
      <div className="flex flex-col gap-2 pb-1 pt-2">{children}</div>
    </details>
  );
}

export function StepRunPanel({
  workflowId,
  run,
  stepRunId,
  onSelectStepRun,
}: {
  workflowId: string;
  run: Run;
  stepRunId: string;
  onSelectStepRun: (stepRunId: string) => void;
}) {
  const { data, isLoading } = useStepRun(workflowId, run.id, stepRunId);
  const stepRun = data?.stepRun;
  if (isLoading || !stepRun?.summary) return <Skeleton className="m-3 h-40" />;
  const summary = stepRun.summary;
  const failed = summary.status === StepRunStatus.FAILED;

  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="step-run-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {summary.stepName}
        </h2>
        <StepRunStatusBadge status={summary.status} />
      </div>
      <StatusSection stepRun={stepRun} />
      {failed && <ErrorSection workflowId={workflowId} run={run} stepRun={stepRun} />}
      <Section id="inputs" title="Inputs" defaultOpen>
        {stepRun.resolvedInputs.length === 0 && (
          <p className="text-xs text-ink-subtle">No inputs.</p>
        )}
        {stepRun.resolvedInputs.map((input) => (
          <InputValue key={input.name} input={input} onSelectStepRun={onSelectStepRun} />
        ))}
      </Section>
      {summary.stepKind === StepKind.PI && (
        <Section id="session" title="Session" defaultOpen>
          <SessionView stepRun={stepRun} />
        </Section>
      )}
      <Section id="output" title="Output" defaultOpen>
        <StepOutput stepRun={stepRun} />
      </Section>
      <Section id="configuration" title="Configuration used" defaultOpen={false}>
        <ConfigurationUsed stepRun={stepRun} />
      </Section>
    </div>
  );
}

function StatusSection({ stepRun }: { stepRun: StepRun }) {
  const s = stepRun.summary!;
  const started = tsToDate(s.startedAt);
  const ended = tsToDate(s.endedAt);
  return (
    <div
      className="flex flex-col gap-1 border-b border-border px-3 py-2 text-xs text-ink-muted"
      data-testid="step-run-status"
    >
      <div className="flex gap-4">
        <span>Started {started ? formatExact(started) : "—"}</span>
        <span>Ended {ended ? formatExact(ended) : "—"}</span>
      </div>
      <span>
        Duration{" "}
        <Duration
          ms={s.elapsedMs === undefined ? undefined : Number(s.elapsedMs)}
          from={s.elapsedMs === undefined ? started : undefined}
          to={ended}
          live={isLiveStepRun(s.status)}
          className="text-ink"
        />
      </span>
      {s.skippedReason && <p className="text-ink">{s.skippedReason}</p>}
    </div>
  );
}

function ErrorSection({
  workflowId,
  run,
  stepRun,
}: {
  workflowId: string;
  run: Run;
  stepRun: StepRun;
}) {
  const [error, setError] = useState<string | null>(null);
  const retry = useRetryStep((e) => setError(appErrorToast(e)));
  const summary = stepRun.summary!;
  const runFinished = !isLiveRun(run.status);
  return (
    <div
      className="flex flex-col gap-2 border-b border-border bg-status-failed/5 px-3 py-3"
      data-testid="step-run-error"
    >
      <p className="text-sm font-medium text-status-failed">
        {summary.humanError ?? "This step failed."}
      </p>
      {stepRun.technicalError && (
        <details className="text-xs">
          <summary className="cursor-pointer text-ink-muted">Technical detail</summary>
          <div className="pt-1">
            <ClippedText text={stepRun.technicalError} />
          </div>
        </details>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!runFinished}
          title={runFinished ? undefined : "The run must be finished before retrying a step."}
          loading={retry.isPending}
          onClick={() => {
            setError(null);
            retry.mutate({ workflowId, runId: run.id, stepRunId: summary.id });
          }}
        >
          Retry step
        </Button>
        {error && (
          <p className="text-xs text-status-failed" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function InputValue({
  input,
  onSelectStepRun,
}: {
  input: ResolvedInput;
  onSelectStepRun: (id: string) => void;
}) {
  const json = valueToJson(input.value);
  const source = input.source;
  const [asMarkdown, setAsMarkdown] = useState(false);
  const text = typeof json === "string" ? json : undefined;
  const structured = json !== undefined && json !== null && typeof json === "object";

  return (
    <div className="flex flex-col gap-1" data-testid={`resolved-input-${input.name}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono font-medium text-ink">{input.name}</span>
        {source?.stepRunId ? (
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => onSelectStepRun(source.stepRunId!)}
          >
            {source.label}
          </button>
        ) : (
          <span className="text-ink-subtle">{source?.label}</span>
        )}
        {text !== undefined && !looksLikeJson(text) && (
          <button
            type="button"
            className="ml-auto text-ink-subtle hover:text-ink"
            onClick={() => setAsMarkdown(!asMarkdown)}
          >
            {asMarkdown ? "Text" : "Markdown"}
          </button>
        )}
      </div>
      {json === undefined || json === null ? (
        <p className="text-xs text-ink-subtle">No value.</p>
      ) : structured ? (
        <div className="rounded-md bg-surface-2 p-2">
          <JsonTree value={json} />
        </div>
      ) : asMarkdown && text !== undefined ? (
        <Markdown text={text} />
      ) : (
        <ClippedText text={text ?? JSON.stringify(json)} />
      )}
    </div>
  );
}

function SessionView({ stepRun }: { stepRun: StepRun }) {
  const live = isLiveStepRun(stepRun.summary!.status);
  return (
    <Tabs defaultValue="transcript">
      <TabsList>
        <TabsTrigger value="transcript">Transcript</TabsTrigger>
        <TabsTrigger value="messages">Messages ({stepRun.messages.length})</TabsTrigger>
      </TabsList>
      <TabsContent value="transcript">
        <Transcript blocks={stepRun.transcript} live={live} />
      </TabsContent>
      <TabsContent value="messages">
        <Messages messages={stepRun.messages} />
      </TabsContent>
    </Tabs>
  );
}

/** Auto-scroll stays pinned to the bottom unless the reader scrolled up. */
export function Transcript({
  blocks,
  live,
}: {
  blocks: readonly TranscriptBlock[];
  live: boolean;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);
  // Blocks the reader has seen; more than that while scrolled up → "Jump to latest".
  const [seen, setSeen] = useState(blocks.length);
  const unseen = !pinned && blocks.length > seen;

  // Follow new blocks while pinned (DOM only).
  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [blocks.length, pinned]);

  if (blocks.length === 0) {
    return (
      <p className="py-2 text-xs text-ink-subtle">
        {live ? "Waiting for the agent…" : "No session content."}
      </p>
    );
  }
  return (
    <div className="relative">
      <div
        ref={box}
        data-testid="transcript"
        className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto py-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 16;
          setPinned(atBottom);
          if (atBottom) setSeen(blocks.length);
        }}
      >
        {blocks.map((block, i) => (
          <TranscriptItem key={i} block={block} />
        ))}
      </div>
      {unseen && (
        <Button
          size="sm"
          variant="primary"
          className="absolute bottom-2 right-2 shadow"
          onClick={() => {
            const el = box.current;
            if (el) el.scrollTop = el.scrollHeight;
            setPinned(true);
            setSeen(blocks.length);
          }}
        >
          Jump to latest
        </Button>
      )}
    </div>
  );
}

function TranscriptItem({ block }: { block: TranscriptBlock }) {
  const b = block.block;
  switch (b.case) {
    case "text":
      return <Markdown text={b.value.text} />;
    case "thinking":
      return (
        <details className="text-xs text-ink-subtle">
          <summary className="cursor-pointer">Thinking</summary>
          <p className="whitespace-pre-wrap pt-1">{b.value.text}</p>
        </details>
      );
    case "tool": {
      const state = describeToolState(b.value.state);
      return (
        <div
          className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs"
          data-testid="transcript-tool"
        >
          <StatusDot tone={state.tone} pulse={b.value.state === ToolState.RUNNING} />
          <span className="font-mono font-medium text-ink">{b.value.name}</span>
          <span className="min-w-0 flex-1 truncate text-ink-muted">{b.value.summary}</span>
          <span className="sr-only">{state.label}</span>
        </div>
      );
    }
    default:
      return null;
  }
}

function Messages({ messages }: { messages: readonly AgentMessage[] }) {
  if (messages.length === 0)
    return <p className="py-2 text-xs text-ink-subtle">No agent messages.</p>;
  return (
    <ol className="flex flex-col gap-2 py-2">
      {messages.map((m, i) => (
        <li key={i} className="rounded-md border border-border p-2 text-xs">
          <div className="flex gap-2 text-ink-muted">
            <span className="font-medium text-ink">{m.role}</span>
            {m.toolCalls > 0 && <span>{m.toolCalls} tool calls</span>}
            {m.stopReason && <span className="ml-auto">{m.stopReason}</span>}
          </div>
          {m.text && <p className="whitespace-pre-wrap pt-1 text-ink">{m.text}</p>}
          {m.error && <p className="pt-1 text-status-failed">{m.error}</p>}
        </li>
      ))}
    </ol>
  );
}

function ConfigurationUsed({ stepRun }: { stepRun: StepRun }) {
  const rows: Array<[string, ReactNode]> = [
    ["Prompt", stepRun.prompt ? <ClippedText text={stepRun.prompt} /> : null],
    [
      "Additional context",
      stepRun.additionalContext ? <ClippedText text={stepRun.additionalContext} /> : null,
    ],
    [
      "Expected output",
      stepRun.expectedOutput ? <ClippedText text={stepRun.expectedOutput} mono={false} /> : null,
    ],
    ["Model", stepRun.modelId ? <span className="font-mono">{stepRun.modelId}</span> : null],
    ["Temperature", stepRun.temperature === undefined ? null : String(stepRun.temperature)],
    ["Tools", stepRun.enabledToolNames.length > 0 ? stepRun.enabledToolNames.join(", ") : "None"],
  ];
  return (
    <dl className="flex flex-col gap-2 text-xs" data-testid="configuration-used">
      {rows
        .filter(([, v]) => v !== null)
        .map(([label, v]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <dt className="font-medium text-ink-muted">{label}</dt>
            <dd className="text-ink">{v}</dd>
          </div>
        ))}
    </dl>
  );
}
