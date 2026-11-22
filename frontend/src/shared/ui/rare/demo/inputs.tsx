// RareUI-inspired inputs demos (rareui.com) — reimplemented on the Glyph design system.
import { useState } from "react";
import type { ReactNode } from "react";
import type { DemoEntry } from "./frame";
import { Button } from "@/shared/ui";
// eslint-disable-next-line boundaries/dependencies
import { useTheme } from "@/app/theme";
import { DurationPicker } from "../duration-picker";
import type { DurationValue } from "../duration-picker";
import { OtpInput } from "../otp-input";
import { PasswordInput } from "../password-input";
import { ThemeSelector } from "../theme-selector";
import { DeleteButton } from "../delete-button";
import { TaskList } from "../task-list";
import type { Task } from "../task-list";

function DurationDemo() {
  const [value, setValue] = useState<DurationValue>({ hours: 3, minutes: 30 });
  return (
    <div className="flex flex-col items-center gap-3">
      <DurationPicker value={value} onChange={setValue} onConfirm={setValue} />
      <p className="text-xs text-ink-subtle">
        Confirmed: {value.hours}h {value.minutes}m — click to edit, Enter or ✓ to confirm, Esc to
        cancel. Try typing 99 minutes.
      </p>
    </div>
  );
}

function OtpDemo() {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  return (
    <div className="flex flex-col items-center gap-3">
      <OtpInput
        value={code}
        status={status}
        onChange={(v) => {
          setCode(v);
          setStatus("idle");
        }}
        onComplete={(v) => setStatus(v.endsWith("7") ? "success" : "error")}
      />
      <p className="text-xs text-ink-subtle">
        Type a 6-digit code — ends in 7 for success, anything else fails. Try pasting{" "}
        <span className="font-mono">123457</span>.
      </p>
    </div>
  );
}

function PasswordDemo() {
  const [value, setValue] = useState("");
  return (
    <div className="w-64">
      <PasswordInput
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Password"
        name="demo-password"
        autoComplete="new-password"
      />
    </div>
  );
}

function LiveThemeDemo() {
  const { theme, setTheme } = useTheme();
  return (
    <ThemeSelector
      value={theme}
      onChange={(v) => {
        if (v === "light" || v === "dark") setTheme(v);
      }}
    />
  );
}

function DeleteDemo() {
  const [rows, setRows] = useState(["Workflow spec", "Run #1042", "Draft canvas"]);
  const [note, setNote] = useState<string | null>(null);
  const wrap = (children: ReactNode) => <div className="flex flex-col items-center gap-3">{children}</div>;
  if (rows.length === 0) {
    return wrap(
      <>
        <p className="text-sm text-ink-muted">All gone.</p>
        <Button size="sm" onClick={() => setRows(["Workflow spec", "Run #1042", "Draft canvas"])}>
          Reset
        </Button>
      </>,
    );
  }
  return wrap(
    <>
      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <li key={row} className="flex items-center justify-between gap-6 text-sm text-ink">
            <span>{row}</span>
            <DeleteButton
              onConfirm={() => {
                setRows((r) => r.filter((x) => x !== row));
                setNote(`Deleted "${row}"`);
              }}
              onCancel={() => setNote(`Cancelled on "${row}"`)}
            />
          </li>
        ))}
      </ul>
      {note ? <p className="text-xs text-ink-subtle">{note}</p> : null}
    </>,
  );
}

function TaskDemo() {
  const [tasks, setTasks] = useState<Task[]>([
    { id: "a", label: "Review step config", done: false },
    { id: "b", label: "Wire retry policy", done: false },
    { id: "c", label: "Ship cutover runbook", done: true },
  ]);
  return (
    <TaskList
      tasks={tasks}
      onTasksChange={setTasks}
      className="items-start self-stretch px-2"
    />
  );
}

export const inputDemos: DemoEntry[] = [
  {
    id: "duration-picker",
    title: "Duration Picker",
    description: "Gooey segments; inline edit with clamping shake.",
    element: <DurationDemo />,
  },
  {
    id: "otp-input",
    title: "OTP Input",
    description: "Sliding caret, paste support, success trace / error shake.",
    element: <OtpDemo />,
  },
  {
    id: "password-input",
    title: "Password Input",
    description: "Visibility toggle and 4-segment strength meter.",
    element: <PasswordDemo />,
  },
  {
    id: "theme-selector",
    title: "Theme Selector",
    description: "Miniature app previews — flips the whole gallery theme.",
    element: <LiveThemeDemo />,
  },
  {
    id: "delete-button",
    title: "Delete Button",
    description: "Confirms in place: ✓ to delete, ✕ / Esc to cancel.",
    element: <DeleteDemo />,
  },
  {
    id: "task-list",
    title: "Task List",
    description: "Checking strikes the row and sinks it below pending items.",
    element: <TaskDemo />,
  },
];
