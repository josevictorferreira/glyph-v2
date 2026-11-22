// RareUI-inspired AI kit demo entries (rareui.com) — reimplemented on the Glyph design system.
import { useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/shared/ui";
import { PromptBox } from "@/shared/ui/rare/prompt-box";
import { StreamingResponse } from "@/shared/ui/rare/streaming-response";
import { ModelPicker, type PickerModel } from "@/shared/ui/rare/model-picker";
import {
  WebSearch,
  WebSearchAnswer,
  WebSearchCitation,
  type WebSource,
} from "@/shared/ui/rare/web-search";
import type { DemoEntry } from "./frame";

const REPLIES: string[] = [
  "Here is the **plan**: first *sketch* the DAG, then wire the steps together, and finally run it end to end.\n\n- One input node\n- Two parallel agent steps\n- A reviewer step at the end",
  "The `run` table is immutable evidence — every step run snapshots its configuration, so re-executing a workflow never rewrites history.\n\n1. Dispatch is occurrence-key idempotent\n2. Finalization happens under the run lock\n3. Failed steps skip only queued descendants",
];

const MODELS: PickerModel[] = [
  {
    id: "orion-max",
    name: "Orion Max",
    provider: "Glyph",
    description: "Deepest reasoning",
    speed: 2,
    intelligence: 5,
  },
  { id: "orion", name: "Orion", provider: "Glyph", description: "Balanced default", speed: 4, intelligence: 4 },
  { id: "orion-mini", name: "Orion Mini", provider: "Glyph", description: "Fast and cheap", speed: 5, intelligence: 2 },
  { id: "nimbus", name: "Nimbus", provider: "Cloud", description: "External frontier model", speed: 3, intelligence: 5 },
  { id: "zephyr", name: "Zephyr", provider: "Edge", description: "Runs on-device", speed: 5, intelligence: 3 },
];

const SOURCES: WebSource[] = [
  {
    id: "glyph",
    title: "Glyph — DAG workflows for AI agents",
    url: "https://glyph.dev/docs/workflows",
    snippet: "Design, schedule and run DAG-shaped AI workflows. Runs are immutable evidence.",
  },
  {
    id: "pi",
    title: "Pi coding agent",
    url: "https://example.com/pi-agent",
    snippet: "A coding agent harness with tools, skills and extensions.",
  },
  {
    id: "react",
    title: "React 19",
    url: "https://react.dev/blog/2024/12/05/react-19",
    snippet: "Stable React 19 with Actions, ref as prop and document metadata.",
  },
];

function PromptBoxDemo() {
  const [status, setStatus] = useState<"idle" | "streaming">("idle");
  const [last, setLast] = useState<string>("");
  return (
    <div className="flex w-full max-w-[600px] flex-col items-center gap-3">
      <PromptBox
        status={status}
        placeholder={["Ask anything…", "Design a review workflow…", "Summarize last run's failures…"]}
        onStop={() => setStatus("idle")}
        onSubmit={(prompt, effort) => {
          setLast(`“${prompt}” · ${effort.label}`);
          setStatus("streaming");
        }}
      />
      <div className="flex items-center gap-2 text-xs text-ink-subtle">
        {last && <span className="max-w-72 truncate">{last}</span>}
        <Button size="sm" variant="ghost" onClick={() => setStatus(status === "idle" ? "streaming" : "idle")}>
          {status === "idle" ? "Simulate streaming" : "Finish"}
        </Button>
      </div>
    </div>
  );
}

function StreamingDemo() {
  const [reply, setReply] = useState(0);
  const [status, setStatus] = useState<"streaming" | "done" | "stopped">("done");
  return (
    <div className="flex w-full flex-col gap-3">
      <StreamingResponse
        key={reply}
        text={REPLIES[reply] ?? REPLIES[0]!}
        status={status}
        onRetry={() => setStatus("streaming")}
        onCopy={() => {}}
      />
      <div className="flex gap-2 self-start">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setReply((r) => (r + 1) % REPLIES.length);
            setStatus("streaming");
          }}
        >
          New reply
        </Button>
        {status === "streaming" ? (
          <Button size="sm" variant="ghost" onClick={() => setStatus("stopped")}>
            Stop
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setStatus("done")}>
            Mark done
          </Button>
        )}
      </div>
    </div>
  );
}

function ModelPickerDemo() {
  const [model, setModel] = useState("orion");
  return (
    <div className="flex flex-col items-start gap-2">
      <ModelPicker models={MODELS} value={model} onChange={setModel} />
      <p className="text-xs text-ink-subtle">Selected: {model}</p>
    </div>
  );
}

function WebSearchDemo() {
  const [play, setPlay] = useState(false);
  return (
    <div className="flex w-full max-w-[560px] flex-col gap-3">
      <WebSearch sources={SOURCES} status="done" query="glyph workflow runs" defaultOpen />
      <p className="text-sm leading-relaxed text-ink">
        Runs are immutable evidence
        <WebSearchCitation source={SOURCES[0]!} index={0} /> and every step snapshots its config
        <WebSearchCitation source={SOURCES[1]!} index={1} />.
      </p>
      <div className="flex items-center gap-2">
        <WebSearchAnswer play={play} onComplete={() => setPlay(false)}>
          Glyph executes each step with the Pi coding agent, streaming output along the DAG edges.
        </WebSearchAnswer>
        {!play && (
          <Button size="sm" variant="ghost" onClick={() => setPlay(true)}>
            Replay answer
          </Button>
        )}
      </div>
    </div>
  );
}

function entry(
  id: string,
  title: string,
  description: string,
  element: ReactNode,
  wide = false,
): DemoEntry {
  return { id, title, description, element, wide };
}

export const aiKitInputDemos: DemoEntry[] = [
  entry(
    "prompt-box",
    "Prompt Box",
    "Hold send (or hold Enter) to charge the effort level; release to send. Tap sends Quick.",
    <PromptBoxDemo />,
  ),
  entry(
    "streaming-response",
    "Streaming Response",
    "Reveals word bursts that sharpen into focus; actions bar appears when done.",
    <StreamingDemo />,
  ),
  entry(
    "model-picker",
    "Model Picker",
    "A pill that unfolds into a searchable list with sliding highlight and strength meters.",
    <ModelPickerDemo />,
  ),
  entry(
    "web-search",
    "Web Search",
    "Search pill expanding into source cards, with citations and a typed answer.",
    <WebSearchDemo />,
    true,
  ),
];
