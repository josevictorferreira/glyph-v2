// RareUI-inspired feedback demos (rareui.com) — reimplemented on the Glyph design system.
// Live demos for toast.tsx, emoji-reaction.tsx and notification-bell.tsx.
import { useState } from "react";
import type { ReactNode } from "react";
import type { DemoEntry } from "./frame";
import { Button, toast as stockToast } from "@/shared/ui";
import {
  rareToast,
  RareToaster,
  type RareToastPosition,
} from "@/shared/ui/rare/toast";
import { EmojiReaction } from "@/shared/ui/rare/emoji-reaction";
import { NotificationBell } from "@/shared/ui/rare/notification-bell";

const positions: RareToastPosition[] = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

function ToastDemo() {
  const [position, setPosition] = useState<RareToastPosition>("bottom-right");
  const [mountedAt, setMountedAt] = useState(0);
  // Remount the toaster when the position changes so enter animations replay.
  const key = `${position}@${mountedAt}`;
  const choose = (p: RareToastPosition) => {
    setPosition(p);
    setMountedAt((n) => n + 1);
  };
  const [counter, setCounter] = useState(0);
  return (
    <div className="flex w-full max-w-lg flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => rareToast("Workflow saved")}>
          Neutral
        </Button>
        <Button size="sm" onClick={() => rareToast.success("Run succeeded")}>
          Success
        </Button>
        <Button size="sm" onClick={() => rareToast.error("Step failed", { description: "Retry the step run to continue." })}>
          Error
        </Button>
        <Button size="sm" onClick={() => rareToast.warning("Approaching quota")}>
          Warning
        </Button>
        <Button size="sm" onClick={() => rareToast.info("New version available")}>
          Info
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            rareToast.promise(
              () => new Promise<string>((resolve) => setTimeout(() => resolve("run-42"), 2000)),
              {
                loading: "Deploying workflow…",
                success: (id) => `Deployed ${id}`,
                error: "Deploy failed",
              },
            );
          }}
        >
          Promise (2s)
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const next = counter + 1;
            setCounter(next);
            rareToast(`Uploading… ${next}`, {
              id: "upload-progress",
              tone: "info",
              action: next > 1 ? { label: "Cancel", onClick: () => {} } : undefined,
            });
          }}
        >
          Update by id ({counter})
        </Button>
        <Button size="sm" variant="ghost" onClick={() => stockToast({ title: "Stock toaster" })}>
          Stock toast
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-ink-muted">Position:</span>
        {positions.map((p) => (
          <Button
            key={p}
            size="sm"
            variant={p === position ? "primary" : "ghost"}
            onClick={() => choose(p)}
          >
            {p}
          </Button>
        ))}
      </div>
      {/* One toaster per demo (the key swaps position live). */}
      <RareToaster key={key} position={position} />
    </div>
  );
}

function EmojiDemo() {
  const [last, setLast] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-center gap-3">
      <EmojiReaction onReact={setLast} />
      <p className="text-xs text-ink-muted">
        Last reaction: {last ? <span className="text-ink">{last}</span> : "none yet"}
      </p>
    </div>
  );
}

function BellDemo() {
  const [count, setCount] = useState(3);
  return (
    <div className="flex flex-col items-center gap-4">
      <NotificationBell count={count} onClick={() => setCount(0)} />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setCount((c) => c + 1)}>
          +1
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setCount((c) => Math.max(0, c - 1))}>
          -1
        </Button>
      </div>
    </div>
  );
}

function BadgeStrip() {
  const strip: ReactNode[] = [];
  const cases: [string, { count: number; variant?: "count" | "dot"; color?: NotificationBellColor }][] = [
    ["0", { count: 0 }],
    ["5", { count: 5 }],
    ["100", { count: 100 }],
    ["dot", { count: 7, variant: "dot" }],
    ["green", { count: 2, color: "green" }],
    ["blue", { count: 2, color: "blue" }],
  ];
  for (const [label, props] of cases) {
    strip.push(
      <div key={label} className="flex flex-col items-center gap-1">
        <NotificationBell size={36} {...props} />
        <span className="text-[10px] text-ink-subtle">{label}</span>
      </div>,
    );
  }
  return <div className="flex items-start gap-3">{strip}</div>;
}

type NotificationBellColor = NonNullable<Parameters<typeof NotificationBell>[0]["color"]>;

function BellColorsDemo() {
  return <BadgeStrip />;
}

export const feedbackDemos: DemoEntry[] = [
  {
    id: "feedback-toast",
    title: "Toast",
    description:
      "Sonner-style stack: hover to fan out, swipe to dismiss, promise morphs in place. Compare with the stock toaster.",
    wide: true,
    element: <ToastDemo />,
  },
  {
    id: "feedback-emoji-reaction",
    title: "Emoji reaction",
    description: "Tapback-style trigger — click to open, pick or hold an emoji to repeat it.",
    element: <EmojiDemo />,
  },
  {
    id: "feedback-notification-bell",
    title: "Notification bell",
    description: "Swings on count increases; +1 to trigger. Badge caps at 99+.",
    element: <BellDemo />,
  },
  {
    id: "feedback-notification-bell-variants",
    title: "Notification bell variants",
    description: "Dot variant and badge colors (violet has no token — literal color).",
    element: <BellColorsDemo />,
  },
];
