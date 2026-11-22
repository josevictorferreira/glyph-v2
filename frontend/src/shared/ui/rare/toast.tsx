// RareUI-inspired Toast (rareui.com) — reimplemented on the Glyph design system.
// Gallery-grade Sonner-style toaster: module-level store + pure reducer,
// animated stack (hover fan-out, swipe-to-dismiss, per-tone icons) and
// in-place promise morphs. Deliberately separate from ../toast.tsx.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";
import { AlertTriangle, X } from "@/shared/ui/icons";

export type RareToastTone = "neutral" | "success" | "danger" | "warning" | "info" | "loading";
export type RareToastId = string | number;
export type RareToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface RareToastAction {
  label: string;
  onClick: () => void;
}

export interface RareToastItem {
  id: RareToastId;
  title: ReactNode;
  description?: ReactNode;
  tone: RareToastTone;
  action?: RareToastAction;
  durationMs?: number;
  /** Bumped on every content change; drives auto-dismiss timer resets. */
  rev: number;
}

export type RareToastState = RareToastItem[];

export type RareToastStoreAction =
  | { type: "add"; toast: Omit<RareToastItem, "rev">; cap?: number }
  | { type: "update"; id: RareToastId; patch: Partial<Omit<RareToastItem, "id" | "rev">> }
  | { type: "dismiss"; id: RareToastId }
  | { type: "swipe"; id: RareToastId };

/** Pure reducer behind the toast store (exported for tests). */
export function toastReducer(state: RareToastState, action: RareToastStoreAction): RareToastState {
  switch (action.type) {
    case "add": {
      const at = state.findIndex((t) => t.id === action.toast.id);
      if (at !== -1) {
        // Reusing an id updates the existing toast in place instead of stacking.
        const prev = state[at]!;
        const next = state.slice();
        next[at] = { ...prev, ...action.toast, rev: prev.rev + 1 };
        return next;
      }
      const next = [...state, { ...action.toast, rev: 0 }];
      // Optional cap keeps only the newest `cap` toasts.
      return action.cap !== undefined && next.length > action.cap
        ? next.slice(next.length - action.cap)
        : next;
    }
    case "update":
      return state.map((t) => (t.id === action.id ? { ...t, ...action.patch, rev: t.rev + 1 } : t));
    case "dismiss":
    case "swipe":
      return state.filter((t) => t.id !== action.id);
  }
}

// ---------------------------------------------------------------------------
// Module-level store: plain observable over the pure reducer.
// ---------------------------------------------------------------------------

type Listener = (state: RareToastState) => void;

let storeState: RareToastState = [];
const listeners = new Set<Listener>();

function dispatch(action: RareToastStoreAction): void {
  storeState = toastReducer(storeState, action);
  for (const listener of listeners) listener(storeState);
}

export const rareToastStore = {
  getState(): RareToastState {
    return storeState;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  dismiss(id: RareToastId): void {
    dispatch({ type: "dismiss", id });
  },
  swipe(id: RareToastId): void {
    dispatch({ type: "swipe", id });
  },
};

// ---------------------------------------------------------------------------
// Imperative API: rareToast / rareToast.success / … / rareToast.promise
// ---------------------------------------------------------------------------

export interface RareToastOptions {
  description?: ReactNode;
  action?: RareToastAction;
  durationMs?: number;
  id?: RareToastId;
  tone?: "neutral" | "success" | "danger" | "warning" | "info";
}

type MethodOptions = Omit<RareToastOptions, "tone">;

let autoId = 0;

function emit(title: ReactNode, tone: RareToastTone, options: RareToastOptions = {}): RareToastId {
  const id = options.id ?? `rare-${++autoId}`;
  dispatch({
    type: "add",
    toast: {
      id,
      title,
      tone,
      description: options.description,
      action: options.action,
      durationMs: options.durationMs,
    },
  });
  return id;
}

async function rarePromise<T>(
  task: Promise<T> | (() => Promise<T>),
  messages: {
    loading: ReactNode;
    success: ReactNode | ((data: T) => ReactNode);
    error: ReactNode | ((err: unknown) => ReactNode);
  },
  options?: MethodOptions,
): Promise<T> {
  const id = emit(messages.loading, "loading", options);
  const run = typeof task === "function" ? task() : task;
  try {
    const data = await run;
    const { success } = messages;
    // Same id → the loading toast morphs in place (spinner → check).
    dispatch({
      type: "update",
      id,
      patch: { title: typeof success === "function" ? success(data) : success, tone: "success" },
    });
    return data;
  } catch (err) {
    const { error } = messages;
    dispatch({
      type: "update",
      id,
      patch: { title: typeof error === "function" ? error(err) : error, tone: "danger" },
    });
    throw err;
  }
}

export const rareToast = Object.assign(
  function rareToast(title: ReactNode, options?: RareToastOptions): RareToastId {
    return emit(title, options?.tone ?? "neutral", options);
  },
  {
    success(title: ReactNode, options?: MethodOptions): RareToastId {
      return emit(title, "success", options);
    },
    error(title: ReactNode, options?: MethodOptions): RareToastId {
      return emit(title, "danger", options);
    },
    warning(title: ReactNode, options?: MethodOptions): RareToastId {
      return emit(title, "warning", options);
    },
    info(title: ReactNode, options?: MethodOptions): RareToastId {
      return emit(title, "info", options);
    },
    loading(title: ReactNode, options?: MethodOptions): RareToastId {
      return emit(title, "loading", options);
    },
    promise: rarePromise,
  },
);

// ---------------------------------------------------------------------------
// <RareToaster /> — animated stack.
// ---------------------------------------------------------------------------

const DEFAULT_DURATION_MS = 5000;
const TICK_MS = 250;
const COLLAPSED_PEEK_PX = 14;
const DEFAULT_FRONT_HEIGHT = 64;
const SWIPE_THRESHOLD_PX = 80;

const positionClasses: Record<RareToastPosition, string> = {
  "top-left": "left-0 top-0 items-start",
  "top-center": "left-1/2 top-0 -translate-x-1/2 items-center",
  "top-right": "right-0 top-0 items-end",
  "bottom-left": "left-0 bottom-0 items-start",
  "bottom-center": "left-1/2 bottom-0 -translate-x-1/2 items-center",
  "bottom-right": "right-0 bottom-0 items-end",
};

const EXIT_TRANSITION = { duration: 0.18, ease: "easeIn" } as const;

export interface RareToasterProps {
  position?: RareToastPosition;
  gap?: number;
  maxVisible?: number;
}

export function RareToaster({ position = "bottom-right", gap = 8, maxVisible = 3 }: RareToasterProps) {
  const toasts = useSyncExternalStore(rareToastStore.subscribe, rareToastStore.getState);
  const reduced = useReducedMotion() ?? false;
  const [hovered, setHovered] = useState(false);
  const [frontHeight, setFrontHeight] = useState(DEFAULT_FRONT_HEIGHT);
  const roRef = useRef<ResizeObserver | null>(null);

  const visible = toasts.slice(-maxVisible);

  // Measure the front toast so the hover fan-out spaces cards by real height.
  const setFrontRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (el && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        setFrontHeight(el.offsetHeight || DEFAULT_FRONT_HEIGHT);
      });
      ro.observe(el);
      roRef.current = ro;
    }
  }, []);
  useEffect(() => () => roRef.current?.disconnect(), []);

  // Auto-dismiss countdowns: reset when a toast's content changes (rev bump),
  // sticky while loading, paused while the stack is hovered.
  const timersRef = useRef(new Map<RareToastId, number>());
  const revsRef = useRef(new Map<RareToastId, number>());
  useEffect(() => {
    const timers = timersRef.current;
    const revs = revsRef.current;
    const live = new Set(toasts.map((t) => t.id));
    for (const id of [...timers.keys()]) {
      if (!live.has(id)) {
        timers.delete(id);
        revs.delete(id);
      }
    }
    for (const t of toasts) {
      if (revs.get(t.id) === t.rev) continue;
      revs.set(t.id, t.rev);
      if (t.tone === "loading") timers.delete(t.id);
      else timers.set(t.id, t.durationMs ?? DEFAULT_DURATION_MS);
    }
  }, [toasts]);

  useEffect(() => {
    const iv = window.setInterval(() => {
      if (hovered) return;
      const timers = timersRef.current;
      for (const [id, remaining] of [...timers.entries()]) {
        const next = remaining - TICK_MS;
        if (next <= 0) {
          timers.delete(id);
          rareToastStore.dismiss(id);
        } else {
          timers.set(id, next);
        }
      }
    }, TICK_MS);
    return () => window.clearInterval(iv);
  }, [hovered]);

  const isTop = position.startsWith("top");
  const stackDir = isTop ? 1 : -1; // older toasts sit further from the edge
  const edgeX = position.endsWith("right") ? 1 : position.endsWith("left") ? -1 : 0;
  const edgeY = isTop ? -1 : 1;

  return (
    <div
      className={cn(
        "pointer-events-none fixed z-[100] flex flex-col p-4",
        positionClasses[position],
      )}
    >
      <div className="relative w-[360px]">
        <AnimatePresence>
          {visible.map((toast, i) => {
            const fromFront = visible.length - 1 - i;
            return (
              <ToastCard
                key={toast.id}
                toast={toast}
                fromFront={fromFront}
                isFront={fromFront === 0}
                setFrontRef={setFrontRef}
                stackY={stackDir * fromFront * (hovered ? frontHeight + gap : COLLAPSED_PEEK_PX)}
                scale={hovered ? 1 : 1 - fromFront * 0.05}
                anchorTop={isTop}
                edgeX={edgeX}
                edgeY={edgeY}
                zIndex={40 - fromFront}
                reduced={reduced}
                onHoverChange={setHovered}
              />
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

interface ToastCardProps {
  toast: RareToastItem;
  fromFront: number;
  isFront: boolean;
  setFrontRef: (el: HTMLDivElement | null) => void;
  stackY: number;
  scale: number;
  anchorTop: boolean;
  edgeX: number;
  edgeY: number;
  zIndex: number;
  reduced: boolean;
  onHoverChange: (hovered: boolean) => void;
}

function ToastCard({
  toast,
  isFront,
  setFrontRef,
  stackY,
  scale,
  anchorTop,
  edgeX,
  edgeY,
  zIndex,
  reduced,
  onHoverChange,
}: ToastCardProps) {
  return (
    <motion.div
      ref={isFront ? setFrontRef : undefined}
      role="status"
      data-toast-tone={toast.tone}
      className={cn(
        "group/toast pointer-events-auto absolute inset-x-0 flex items-start gap-3 rounded-card",
        "border border-border bg-surface p-3 shadow-lg",
      )}
      style={anchorTop ? { zIndex, top: 0 } : { zIndex, bottom: 0 }}
      initial={{ opacity: 0, scale: 0.92, x: edgeX * 160, y: edgeY * 48 }}
      animate={{ opacity: 1, scale, x: 0, y: stackY }}
      exit={
        edgeX !== 0
          ? { opacity: 0, x: edgeX * 200, transition: EXIT_TRANSITION }
          : { opacity: 0, y: stackY + edgeY * 48, transition: EXIT_TRANSITION }
      }
      transition={{ type: "spring", stiffness: 400, damping: 32, opacity: { duration: 0.15 } }}
      drag={reduced ? false : "x"}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.7}
      onDragEnd={(_, info) => {
        if (Math.abs(info.offset.x) > SWIPE_THRESHOLD_PX) rareToastStore.swipe(toast.id);
      }}
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
    >
      {toast.tone !== "neutral" && (
        <span className="mt-0.5 flex w-4 shrink-0 justify-center">
          <ToneIcon tone={toast.tone} reduced={reduced} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink">{toast.title}</div>
        {toast.description != null && (
          <div className="mt-0.5 text-xs text-ink-muted">{toast.description}</div>
        )}
      </div>
      {toast.action && (
        <button
          type="button"
          className="mt-0.5 shrink-0 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent-hover hover:text-on-accent"
          onClick={() => {
            toast.action?.onClick();
            rareToastStore.dismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-ink-subtle opacity-0 transition-opacity hover:bg-surface-2 hover:text-ink focus-visible:opacity-100 group-hover/toast:opacity-100"
        onClick={() => rareToastStore.dismiss(toast.id)}
      >
        <X size={14} />
      </button>
    </motion.div>
  );
}

/** Icon slot: crossfades/morphs when the tone changes (spinner → check). */
function ToneIcon({ tone, reduced }: { tone: RareToastTone; reduced: boolean }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={tone}
        layout
        className="flex"
        initial={{ scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.4, opacity: 0 }}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
      >
        <ToneGlyph tone={tone} reduced={reduced} />
      </motion.span>
    </AnimatePresence>
  );
}

function ToneGlyph({ tone, reduced }: { tone: RareToastTone; reduced: boolean }) {
  switch (tone) {
    case "success":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--c-succeeded)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <motion.path
            d="M4.5 12.5l5 5 10-11"
            initial={reduced ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          />
        </svg>
      );
    case "danger":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--c-failed)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <motion.path
            d="M6 6l12 12"
            initial={reduced ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          />
          <motion.path
            d="M18 6L6 18"
            initial={reduced ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.18, ease: "easeOut", delay: 0.08 }}
          />
        </svg>
      );
    case "warning":
      return (
        <motion.span
          className="flex text-attention"
          style={{ color: "var(--c-attention)" }}
          initial={reduced ? false : { x: 0 }}
          animate={reduced ? { x: 0 } : { x: [0, -3, 3, -2, 2, 0] }}
          transition={{ duration: 0.4 }}
        >
          <AlertTriangle size={16} />
        </motion.span>
      );
    case "info":
      return (
        <span className="flex h-4 w-4 items-center justify-center">
          <motion.span
            className="block h-2 w-2 rounded-full"
            style={{ background: "var(--c-accent)" }}
            initial={reduced ? false : { scale: 1, opacity: 0.6 }}
            animate={
              reduced ? { scale: 1, opacity: 1 } : { scale: [1, 1.5, 1], opacity: [0.6, 1, 0.6] }
            }
            transition={{ duration: 1.2, repeat: reduced ? 0 : Infinity, ease: "easeInOut" }}
          />
        </span>
      );
    case "loading":
      return (
        <motion.svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          initial={false}
          animate={reduced ? { opacity: [0.5, 1, 0.5] } : { rotate: 360 }}
          transition={
            reduced
              ? { duration: 1.2, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.8, repeat: Infinity, ease: "linear" }
          }
        >
          <circle
            cx="12"
            cy="12"
            r="9"
            stroke="var(--c-ink-subtle)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray="42"
            strokeDashoffset="30"
          />
        </motion.svg>
      );
    case "neutral":
      return null;
  }
}
