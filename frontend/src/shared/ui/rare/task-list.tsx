// RareUI-inspired TaskList (rareui.com) — reimplemented on the Glyph design system.
import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";
import { Check } from "@/shared/ui/icons";

export type Task = {
  id: string;
  label: string;
  done?: boolean;
};

export type TaskListSize = "sm" | "md" | "lg";

export interface TaskItemProps {
  task: Task;
  onCheckedChange?: (checked: boolean) => void;
  size?: TaskListSize;
  accent?: string;
  className?: string;
}

export interface TaskListProps {
  tasks?: Task[];
  defaultTasks?: Task[];
  onTasksChange?: (tasks: Task[]) => void;
  size?: TaskListSize;
  accent?: string;
  className?: string;
}

const SIZE_STYLES: Record<
  TaskListSize,
  { row: string; box: string; icon: number; text: string }
> = {
  sm: { row: "py-1 px-2 gap-2", box: "h-4 w-4", icon: 10, text: "text-xs" },
  md: { row: "py-1.5 px-2.5 gap-2.5", box: "h-4.5 w-4.5", icon: 12, text: "text-sm" },
  lg: { row: "py-2 px-3 gap-3", box: "h-5 w-5", icon: 14, text: "text-base" },
};

function orderTasks(tasks: Task[]): Task[] {
  const pending: Task[] = [];
  const done: Task[] = [];
  for (const task of tasks) {
    if (task.done) {
      done.push(task);
    } else {
      pending.push(task);
    }
  }
  return [...pending, ...done];
}

export function TaskItem({
  task,
  onCheckedChange,
  size = "md",
  accent = "var(--c-accent)",
  className,
}: TaskItemProps) {
  const reducedMotion = useReducedMotion();
  const checked = Boolean(task.done);
  const styles = SIZE_STYLES[size];

  return (
    <motion.li
      layout
      transition={
        reducedMotion
          ? { duration: 0 }
          : { type: "spring", stiffness: 420, damping: 32 }
      }
      data-slot="task-item"
      data-done={checked ? "true" : "false"}
      className={cn(
        "flex items-center rounded-md border border-transparent transition-colors hover:bg-surface-2",
        styles.row,
        className,
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={task.label}
        onClick={() => onCheckedChange?.(!checked)}
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center rounded-full border transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
          styles.box,
          checked ? "border-transparent text-on-accent" : "border-border-strong bg-surface",
        )}
        style={checked ? { backgroundColor: accent } : undefined}
      >
        <AnimatePresence initial={false}>
          {checked && (
            <motion.span
              key="check"
              initial={reducedMotion ? { scale: 1 } : { scale: 0 }}
              animate={{ scale: 1 }}
              exit={reducedMotion ? { scale: 0 } : { scale: 0 }}
              transition={
                reducedMotion
                  ? { duration: 0 }
                  : { type: "spring", stiffness: 550, damping: 26 }
              }
              className="inline-flex items-center justify-center"
            >
              <Check size={styles.icon} strokeWidth={2.5} />
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      <span
        onClick={() => onCheckedChange?.(!checked)}
        className={cn(
          "relative cursor-pointer select-none transition-colors",
          styles.text,
          checked ? "text-ink-muted" : "text-ink",
        )}
      >
        {task.label}
        <motion.span
          aria-hidden="true"
          initial={false}
          animate={{ width: checked ? "100%" : "0%" }}
          transition={{ duration: reducedMotion ? 0 : 0.2, ease: "easeOut" }}
          className="pointer-events-none absolute top-1/2 left-0 h-px -translate-y-1/2 bg-ink-muted"
        />
      </span>
    </motion.li>
  );
}

export function TaskList({
  tasks,
  defaultTasks = [],
  onTasksChange,
  size = "md",
  accent = "var(--c-accent)",
  className,
}: TaskListProps) {
  const isControlled = tasks !== undefined;
  const [internalTasks, setInternalTasks] = useState<Task[]>(() => orderTasks(defaultTasks));
  const currentTasks = orderTasks(isControlled ? tasks : internalTasks);

  const handleToggle = (id: string, nextDone: boolean) => {
    const updated = currentTasks.map((t) => (t.id === id ? { ...t, done: nextDone } : t));
    const reordered = orderTasks(updated);
    if (!isControlled) {
      setInternalTasks(reordered);
    }
    onTasksChange?.(reordered);
  };

  return (
    <ul
      data-slot="task-list"
      className={cn("flex w-full flex-col gap-0.5", className)}
    >
      {currentTasks.map((task) => (
        <TaskItem
          key={task.id}
          task={task}
          size={size}
          accent={accent}
          onCheckedChange={(checked) => handleToggle(task.id, checked)}
        />
      ))}
    </ul>
  );
}
