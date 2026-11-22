// RareUI-inspired display-b demos (rareui.com) — reimplemented on the Glyph design system.
import { useState } from "react";
import { Button } from "@/shared/ui";
import { Sparkle } from "@/shared/ui/icons";
import { AnimatedCounter } from "../animated-counter";
import { Faq, type FaqItem } from "../faq";
import { StepPlayer, type StepPlayerStep } from "../step-player";
import { VoiceNote } from "../voice-note";
import type { DemoEntry } from "./frame";

const STEP_ITEMS: StepPlayerStep[] = [
  { label: "Plan", duration: 2200 },
  { label: "Draft", duration: 2200 },
  { label: "Review", duration: 2200 },
  { label: "Ship", duration: 2200 },
];

function StepPlayerDemo() {
  const [step, setStep] = useState(0);
  return (
    <div className="flex flex-col items-center gap-3">
      <StepPlayer steps={STEP_ITEMS} value={step} onValueChange={setStep} loop={false} />
      <span className="text-xs text-ink-muted">
        Active step: {step + 1} / {STEP_ITEMS.length}
      </span>
    </div>
  );
}

function AnimatedCounterDemo() {
  const [value, setValue] = useState(1284.5);
  return (
    <div className="flex flex-col items-center gap-3">
      <AnimatedCounter value={value} decimals={1} prefix="$" className="text-2xl font-semibold" />
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => setValue((v) => v - 125.5)}>
          -125.5
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setValue((v) => v + 42.3)}>
          +42.3
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setValue(99999.9)}>
          99,999.9
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setValue(-42)}>
          -42.0
        </Button>
      </div>
    </div>
  );
}

function VoiceNoteDemo() {
  return (
    <div className="flex flex-col items-center gap-3">
      <VoiceNote duration={18} size="md" />
      <VoiceNote duration={42} size="sm" accent="var(--c-succeeded)" />
    </div>
  );
}

const FAQ_ITEMS: FaqItem[] = [
  {
    id: "immutable",
    question: "Are workflow runs immutable?",
    answer:
      "Yes. Every run snapshots the workflow graph and step configuration at dispatch time so historical evidence never drifts.",
  },
  {
    id: "schedule",
    question: "How does scheduled dispatch avoid duplicates?",
    answer:
      "Each scheduled occurrence uses a unique occurrence key combining the workflow ID and RFC3339 timestamp inside a single transaction.",
  },
  {
    id: "tools",
    question: "Which tools can the chat agent call?",
    answer:
      "The chat agent is restricted to the ten Glyph workflow tools and never has access to built-in filesystem or shell tools.",
  },
];

function FaqDemo() {
  return (
    <div className="w-full max-w-md">
      <Faq
        items={FAQ_ITEMS}
        defaultValue="immutable"
        avatar={
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-accent">
            <Sparkle size={14} />
          </span>
        }
      />
    </div>
  );
}

export const displayBDemos: DemoEntry[] = [
  {
    id: "step-player",
    title: "StepPlayer",
    description: "Stepped progress pill with play/pause/replay morph and seekable dots.",
    element: <StepPlayerDemo />,
  },
  {
    id: "animated-counter",
    title: "AnimatedCounter",
    description:
      "Odometer digit strips with edge fade, grouping separators, and place transitions.",
    element: <AnimatedCounterDemo />,
  },
  {
    id: "voice-note",
    title: "VoiceNote",
    description: "Waveform scrubber with speed cycling, keyboard seek, and timer simulation.",
    element: <VoiceNoteDemo />,
  },
  {
    id: "faq",
    title: "Faq",
    description: "Chat-thread single-open accordion with arrow-key focus traversal.",
    wide: true,
    element: <FaqDemo />,
  },
];
