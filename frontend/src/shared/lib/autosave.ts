// useAutosaveField (spec 0015): debounced field saving for the editor.
// Local draft wins while focused or dirty; upstream (server) values replace
// the field only when clean. Works for grouped object values (e.g. output
// name + format saved by one UpdateStepOutput call).
//
// Callers must pass a stable `save` (useCallback): its identity is a flush
// effect dependency.
//
// Upstream-change detection intentionally runs during render (the React
// "adjust state when props change" pattern) via refs, so the react-hooks/refs
// rule is disabled for this file.
/* eslint-disable react-hooks/refs */
import { useCallback, useEffect, useRef, useState } from "react";

export type AutosaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export interface AutosaveField<T> {
  /** What the input should render: draft > frozen > committed > upstream. */
  value: T;
  setValue(next: T): void;
  /** Flush and release the focus lock (input onBlur). */
  onBlur(): void;
  /** Acquire the focus lock (input onFocus). */
  onFocus(): void;
  /** Save now if a dirty draft exists. */
  flush(): Promise<void>;
  status: AutosaveStatus;
  /** Raw error from the failed save; screens map it with toAppError. */
  error: unknown;
  /** Re-attempt the last failed/unsaved draft. */
  retry(): void;
  /** A remote change arrived while dirty or focused. */
  remoteUpdated: boolean;
  /** Adopt the remote value, dropping the local draft ("Use theirs"). */
  takeRemote(): void;
}

export interface UseAutosaveFieldOptions<T> {
  /** Upstream (server) value. */
  value: T;
  save: (next: T) => Promise<void>;
  debounceMs?: number;
  equals?: (a: T, b: T) => boolean;
}

export function useAutosaveField<T>(opts: UseAutosaveFieldOptions<T>): AutosaveField<T> {
  const { value, save, debounceMs = 600, equals = Object.is } = opts;

  const [draft, setDraft] = useState<T | undefined>(undefined); // user edits
  const [frozen, setFrozen] = useState<T | undefined>(undefined); // focus lock
  const [committed, setCommitted] = useState<T | undefined>(undefined); // own write awaiting echo
  const [focused, setFocused] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [justSaved, setJustSaved] = useState(false);
  const [remoteUpdated, setRemoteUpdated] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ draft, frozen, committed });
  latest.current = { draft, frozen, committed };
  // The last value the field displayed, for the focus-freeze path.
  const lastDisplay = useRef<T>(value);
  // Upstream value at the moment of our last successful save: while the
  // prop still equals it, we are seeing a stale snapshot, not a foreign change.
  const preSaveBase = useRef<T | undefined>(undefined);

  // --- upstream change handling (render phase, own-state only) ------------
  const remoteBase = useRef(value);
  if (!equals(remoteBase.current, value)) {
    const { draft: d, frozen: f, committed: c } = latest.current;
    if (d === undefined && f === undefined && c !== undefined && equals(c, remoteBase.current)) {
      // A save succeeded and we are waiting for the upstream echo.
      if (equals(value, c)) {
        setCommitted(undefined); // echo arrived, absorb (keep "saved")
        preSaveBase.current = undefined;
        remoteBase.current = value;
      } else if (preSaveBase.current !== undefined && equals(value, preSaveBase.current)) {
        // stale pre-save snapshot still rendering — ignore until echo
      } else {
        setCommitted(undefined); // foreign change superseded our write
        setJustSaved(false);
        setRemoteUpdated(true);
        preSaveBase.current = undefined;
        remoteBase.current = value;
      }
    } else if (d === undefined && f === undefined) {
      if (focused) {
        setFrozen(lastDisplay.current); // lock what the user is looking at
        setRemoteUpdated(true);
      } else {
        setCommitted(undefined);
        setJustSaved(false);
      }
      remoteBase.current = value;
    } else if (d !== undefined && !equals(d, value)) {
      setRemoteUpdated(true);
      remoteBase.current = value;
    }
  }

  const display =
    draft !== undefined
      ? draft
      : frozen !== undefined
        ? frozen
        : committed !== undefined
          ? committed
          : value;
  lastDisplay.current = display;

  const doSave = useCallback(
    async (next: T) => {
      setSaving(true);
      setError(undefined);
      try {
        preSaveBase.current = remoteBase.current;
        await save(next);
        setSaving(false);
        setDraft(undefined);
        setFrozen(undefined);
        setCommitted(next);
        remoteBase.current = next;
        setJustSaved(true);
        setRemoteUpdated(false);
      } catch (e) {
        setSaving(false);
        setError(e);
        // keep the draft for retry()
      }
    },
    [save],
  );

  const schedule = useCallback(
    (next: T) => {
      setFrozen(undefined); // editing overrides the focus lock
      setDraft(next);
      setError(undefined);
      setJustSaved(false);
      setRemoteUpdated(false);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        if (!equals(next, remoteBase.current)) void doSave(next);
        else setDraft(undefined);
      }, debounceMs);
    },
    [debounceMs, doSave, equals],
  );

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    const pending = latest.current.draft;
    if (pending === undefined) return;
    if (equals(pending, remoteBase.current)) {
      setDraft(undefined);
      return;
    }
    await doSave(pending);
  }, [doSave, equals]);

  // Flush pending debounced saves on unmount (route change).
  useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = undefined;
        const pending = latest.current.draft;
        if (pending !== undefined && !equals(pending, remoteBase.current)) void doSave(pending);
      }
    };
  }, [doSave, equals]);

  // Warn before leaving with unsaved or failed edits.
  useEffect(() => {
    const dirty = draft !== undefined || saving || error !== undefined;
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [draft, saving, error]);

  return {
    value: display,
    setValue: schedule,
    onBlur: () => {
      setFocused(false);
      setFrozen(undefined); // focus lock released; upstream may flow again
      void flush();
    },
    onFocus: () => setFocused(true),
    flush,
    status:
      error !== undefined
        ? "error"
        : saving
          ? "saving"
          : draft !== undefined
            ? "dirty"
            : justSaved
              ? "saved"
              : "idle",
    error,
    retry: () => {
      const pending = latest.current.draft ?? latest.current.committed;
      if (pending !== undefined) void doSave(pending);
    },
    remoteUpdated,
    takeRemote: () => {
      setDraft(undefined);
      setFrozen(undefined);
      setCommitted(undefined);
      setRemoteUpdated(false);
      setJustSaved(false);
      setError(undefined);
    },
  };
}

/** Workspace header aggregation (spec 0015): one indicator for many fields. */
export function combineAutosaveStatuses(statuses: Iterable<AutosaveStatus>): AutosaveStatus {
  const order: AutosaveStatus[] = ["error", "saving", "dirty", "saved", "idle"];
  const rank = new Map(order.map((s, i) => [s, i] as const));
  let worst: AutosaveStatus = "idle";
  for (const s of statuses) {
    if (rank.get(s)! < rank.get(worst)!) worst = s;
  }
  return worst;
}
