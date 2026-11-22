// RareUI-inspired demos (rareui.com) — reimplemented on the Glyph design system.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/shared/ui";
import { FluidOrb } from "../fluid-orb";
import { MatrixOrb, type MatrixOrbState } from "../matrix-orb";
import { GridReveal } from "../grid-reveal";
import { AiStatus, type AiStatusState } from "../ai-status";
import type { DemoEntry } from "./frame";

/** A 1×1 GIF as a data URI — an image that decodes without a network. */
const SAMPLE_IMAGE =
  "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";

function OrbDemo() {
  const colors = ["#5B5BD6", "#0F766E", "#B45309", "#BE185D"];
  const [i, setI] = useState(0);
  return (
    <div className="flex flex-col items-center gap-3">
      <FluidOrb color={colors[i]} />
      <Button size="sm" variant="secondary" onClick={() => setI((v) => (v + 1) % colors.length)}>
        Cycle color
      </Button>
    </div>
  );
}

function MatrixDemo() {
  const states: MatrixOrbState[] = ["idle", "listening", "thinking"];
  const [i, setI] = useState(0);
  return (
    <div className="flex flex-col items-center gap-3">
      <MatrixOrb
        state={states[i] ?? "idle"}
        labels={{ idle: "Idle", listening: "Listening…", thinking: "Thinking…" }}
      />
      <Button size="sm" variant="secondary" onClick={() => setI((v) => (v + 1) % states.length)}>
        Cycle state
      </Button>
    </div>
  );
}

function GridDemo() {
  const [src, setSrc] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (src === null) return;
    const id = window.setTimeout(() => {
      setSrc(null);
      setRound((r) => r + 1);
    }, 3500);
    return () => window.clearTimeout(id);
  }, [src]);
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3">
      <GridReveal
        key={round}
        src={src}
        alt="Generated artwork"
        caption="Sketching composition"
        estimatedDuration={4000}
      />
      <Button
        size="sm"
        variant="secondary"
        onClick={() => (src === null ? setSrc(SAMPLE_IMAGE) : setSrc(null))}
      >
        {src === null ? "Deliver image" : "Reset"}
      </Button>
    </div>
  );
}

function StatusDemo() {
  const states: AiStatusState[] = [
    "thinking",
    "researching",
    "analyzing",
    "writing",
    "done",
    "error",
  ];
  const [i, setI] = useState(0);
  const state = states[i] ?? "thinking";
  return (
    <div className="flex w-full flex-col items-start gap-3">
      <AiStatus state={state} timer detail={state === "researching" ? "4 sources" : undefined} />
      <Button size="sm" variant="secondary" onClick={() => setI((v) => (v + 1) % states.length)}>
        Next state
      </Button>
    </div>
  );
}

function StatusGallery() {
  const items: { state: AiStatusState; detail?: string }[] = [
    { state: "thinking" },
    { state: "researching", detail: "4 sources" },
    { state: "analyzing", detail: "diff of 2 branches" },
    { state: "writing", detail: "section 3" },
    { state: "done" },
    { state: "error", detail: "provider 500" },
  ];
  return (
    <div className="flex w-full flex-col items-start gap-2.5">
      {items.map((it) => (
        <AiStatus key={it.state} state={it.state} detail={it.detail} timer />
      ))}
    </div>
  );
}

function TimerDemo(): ReactNode {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setElapsed((v) => v + 3), 3000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="flex flex-col items-start gap-2">
      <AiStatus state="researching" detail="scanning logs" elapsed={elapsed} />
      <span className="text-xs text-ink-subtle">external elapsed counter</span>
    </div>
  );
}

export const aiKitOrbDemos: DemoEntry[] = [
  {
    id: "fluid-orb",
    title: "FluidOrb",
    description: "Ambient orb with drifting fluid shading — canvas, pausable, reduced-motion safe.",
    element: <OrbDemo />,
  },
  {
    id: "matrix-orb",
    title: "MatrixOrb",
    description: "Dot-matrix orb with per-state bloom envelopes (idle, listening, thinking).",
    element: <MatrixDemo />,
  },
  {
    id: "grid-reveal",
    title: "GridReveal",
    description:
      "Loading state for AI images: splitting grid, progress pill, crossfade on arrival.",
    wide: true,
    element: <GridDemo />,
  },
  {
    id: "ai-status",
    title: "AiStatus",
    description: "Inline AI activity line: animated icon, shimmering label, elapsed timer.",
    element: <StatusDemo />,
  },
  {
    id: "ai-status-gallery",
    title: "AiStatus — every state",
    description: "thinking / researching / analyzing / writing / done / error.",
    element: <StatusGallery />,
  },
  {
    id: "ai-status-timer",
    title: "AiStatus — external elapsed",
    description: "elapsed prop replaces the internal count.",
    element: <TimerDemo />,
  },
];
