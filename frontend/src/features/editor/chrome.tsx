// Workspace chrome state (spec 0018): the readiness sheet visibility and
// editor focus requests (deep links) shared between the workspace layout
// (header) and the build tab (contextual panel). Provided once by the
// /workflows/$id layout, next to LiveProvider.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type StepEditorTab = "instructions" | "inputs" | "model" | "output" | "settings";
export type WorkflowPanelSection = "details" | "values" | "schedule";
export type EditorFocusTarget = StepEditorTab | WorkflowPanelSection;

export function isStepEditorTab(target: EditorFocusTarget): target is StepEditorTab {
  return target !== "details" && target !== "values" && target !== "schedule";
}

/** A deep-link request: select this step, open this tab, focus this field. */
export interface EditorFocus {
  stepId?: string;
  target: EditorFocusTarget;
  /** data-editor-field value to focus once the tab has rendered. */
  field?: string;
  /** Re-triggers identical requests (Date.now()). */
  nonce: number;
}

interface EditorChrome {
  readinessOpen: boolean;
  setReadinessOpen: (open: boolean) => void;
  focus: EditorFocus | null;
  requestFocus: (focus: Omit<EditorFocus, "nonce">) => void;
  /** Select a step on the canvas (URL ?step=); owned by the layout route. */
  selectStep: (stepId: string | null) => void;
}

const ChromeContext = createContext<EditorChrome | null>(null);

export function EditorChromeProvider({
  children,
  selectStep,
}: {
  children: ReactNode;
  selectStep: (stepId: string | null) => void;
}) {
  const [readinessOpen, setReadinessOpen] = useState(false);
  const [focus, setFocus] = useState<EditorFocus | null>(null);
  const requestFocus = useCallback((next: Omit<EditorFocus, "nonce">) => {
    setFocus({ ...next, nonce: Date.now() });
  }, []);
  const value = useMemo(
    () => ({ readinessOpen, setReadinessOpen, focus, requestFocus, selectStep }),
    [readinessOpen, focus, requestFocus, selectStep],
  );
  return <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>;
}

export function useEditorChrome(): EditorChrome {
  const ctx = useContext(ChromeContext);
  if (!ctx) throw new Error("useEditorChrome requires EditorChromeProvider (workspace layout)");
  return ctx;
}

/** Focus the field a deep link points at, once its tab has rendered. */
export function useEditorFocusField(focus: EditorFocus | null, target: EditorFocusTarget) {
  useEffect(() => {
    if (!focus || focus.target !== target || !focus.field) return;
    document
      .querySelector<HTMLElement>(`[data-editor-field="${CSS.escape(focus.field)}"]`)
      ?.focus();
  }, [focus, target]);
}
