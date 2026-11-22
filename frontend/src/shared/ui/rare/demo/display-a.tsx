// RareUI-inspired Display-A Demos (rareui.com) — reimplemented on the Glyph design system.
import { useState } from "react";
import { Button } from "@/shared/ui";
import type { DemoEntry } from "./frame";
import { Folder } from "../folder";
import { CodeBlock } from "../code-block";
import { GravityLetters } from "../gravity-letters";
import { GitHubActivity } from "../github-activity";

const SAMPLE_TS = `// Dispatch a workflow run
import { createRun } from "./runner";

export async function trigger(workflowId: string) {
  const count = 3;
  return createRun({ workflowId, retries: count });
}`;

function CodeBlockDemo() {
  const [accent, setAccent] = useState("#5B5BD6");
  const [lineNumbers, setLineNumbers] = useState(true);

  return (
    <div className="flex w-full flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant={accent === "#5B5BD6" ? "primary" : "secondary"}
          onClick={() => setAccent("#5B5BD6")}
        >
          Indigo
        </Button>
        <Button
          size="sm"
          variant={accent === "#0F766E" ? "primary" : "secondary"}
          onClick={() => setAccent("#0F766E")}
        >
          Teal
        </Button>
        <Button
          size="sm"
          variant={accent === "#B45309" ? "primary" : "secondary"}
          onClick={() => setAccent("#B45309")}
        >
          Amber
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setLineNumbers((v) => !v)}>
          {lineNumbers ? "Hide lines" : "Show lines"}
        </Button>
      </div>
      <CodeBlock
        code={SAMPLE_TS}
        language="typescript"
        filename="trigger.ts"
        accent={accent}
        showLineNumbers={lineNumbers}
        highlightLines={[5]}
      />
    </div>
  );
}

function GravityLettersDemo() {
  const [kind, setKind] = useState<"letters" | "numbers" | "both">("both");

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-center gap-1.5">
        {(["letters", "numbers", "both"] as const).map((k) => (
          <Button
            key={k}
            size="sm"
            variant={kind === k ? "primary" : "secondary"}
            onClick={() => setKind(k)}
          >
            {k}
          </Button>
        ))}
      </div>
      <GravityLetters type={kind} />
    </div>
  );
}

export const displayADemos: DemoEntry[] = [
  {
    id: "folder",
    title: "Folder",
    description: "Hover to fan cards; click to open/close in 3D perspective.",
    element: (
      <div className="flex flex-wrap items-end justify-center gap-6 py-4">
        <Folder color="accent" size="sm" />
        <Folder color="light" size="md" />
        <Folder color="dark" size="md" />
      </div>
    ),
  },
  {
    id: "code-block",
    title: "CodeBlock",
    description: "Accent-derived theme, naive tokenizer, line highlights, spring copy.",
    element: <CodeBlockDemo />,
  },
  {
    id: "gravity-letters",
    title: "GravityLetters",
    description: "Canvas 2D particle stack. Click or hold to pour glyphs.",
    element: <GravityLettersDemo />,
  },
  {
    id: "github-activity",
    title: "GitHubActivity",
    description: "Contribution heatmap with expandable repository breakdown.",
    wide: true,
    element: <GitHubActivity className="w-full max-w-xl" />,
  },
];
