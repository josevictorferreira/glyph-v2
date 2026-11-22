// RareUI-inspired component gallery (dev only). All 31 RareUI components
// (rareui.com) reimplemented on the Glyph design system; see
// src/shared/ui/rare/. Reimplementation per RareUI's attribution license —
// credit link in the footer below.
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/shared/ui";
import { useTheme } from "@/app/theme";
import { DemoSection } from "@/shared/ui/rare/demo/frame";
import { aiKitOrbDemos } from "@/shared/ui/rare/demo/ai-kit-orbs";
import { aiKitInputDemos } from "@/shared/ui/rare/demo/ai-kit-inputs";
import { displayADemos } from "@/shared/ui/rare/demo/display-a";
import { displayBDemos } from "@/shared/ui/rare/demo/display-b";
import { navigationDemos } from "@/shared/ui/rare/demo/navigation";
import { inputDemos } from "@/shared/ui/rare/demo/inputs";
import { feedbackDemos } from "@/shared/ui/rare/demo/feedback";

export const Route = createFileRoute("/dev/rare")({
  component: import.meta.env.PROD ? DevNotFound : RareGallery,
});

function DevNotFound() {
  return (
    <div className="p-6 text-sm text-ink-muted">
      The /dev page is only available in development.
    </div>
  );
}

function RareGallery() {
  const { theme, toggle } = useTheme();

  return (
    <div className="h-full overflow-y-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-border bg-surface px-4 py-2.5 md:px-6">
        <div>
          <h1 className="text-sm font-semibold">RareUI gallery (dev only)</h1>
          <p className="text-xs text-ink-subtle">
            31 components reimplemented on the Glyph design system
          </p>
        </div>
        <Button size="sm" onClick={toggle}>
          Theme: {theme}
        </Button>
      </div>

      <DemoSection title="AI kit — orbs & status" entries={aiKitOrbDemos} />
      <DemoSection title="AI kit — inputs & answers" entries={aiKitInputDemos} />
      <DemoSection title="Display A — folder, code, gravity, activity" entries={displayADemos} />
      <DemoSection title="Display B — step player, counter, voice, FAQ" entries={displayBDemos} />
      <DemoSection title="Navigation" entries={navigationDemos} />
      <DemoSection title="Inputs" entries={inputDemos} />
      <DemoSection title="Feedback" entries={feedbackDemos} />

      <footer className="flex flex-wrap items-center gap-2 px-4 py-5 text-xs text-ink-subtle md:px-6">
        <span>
          Component designs inspired by{" "}
          <a
            href="https://www.rareui.com"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-accent hover:underline"
          >
            Rare UI
          </a>{" "}
          — reimplemented from behavioral specs on the Glyph design system.
        </span>
      </footer>
    </div>
  );
}
