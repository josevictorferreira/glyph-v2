// Thin React wrapper around lazy Monaco (spec 0021). It owns only the editor
// instance, its model, external markers and the ⌘S command — all behavior
// comes in as props. jsdom cannot run the yaml worker, so tests mock this
// module; everything else in the feature is plain React.
import { useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import { loadMonaco } from "./monaco-loader";
import { cn } from "@/shared/lib/cn";

export interface ExternalError {
  /** 1-based; errors without a line only appear in the problems list. */
  line?: number;
  message: string;
}

export interface YamlEditorApi {
  /** Scroll a line into view, place the cursor there and focus. */
  revealLine(line: number): void;
}

export interface YamlEditorProps {
  value: string;
  onChange?: (value: string) => void;
  /** Unique file name per mounted editor (models and the schema attach to it). */
  file: string;
  /** Semantic (dry-run/apply) errors rendered as line markers. */
  errors?: ExternalError[];
  readOnly?: boolean;
  /** ⌘S / Ctrl+S inside the editor. */
  onSave?: () => void;
  onReady?: (api: YamlEditorApi) => void;
  className?: string;
  "data-testid"?: string;
}

export function YamlEditor(props: YamlEditorProps) {
  const { value, file, readOnly, className, "data-testid": testid } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [instance, setInstance] = useState<{
    monaco: typeof Monaco;
    editor: Monaco.editor.IStandaloneCodeEditor;
    model: Monaco.editor.ITextModel;
  } | null>(null);
  // Latest callbacks without re-creating the editor.
  const onChangeRef = useRef(props.onChange);
  const onSaveRef = useRef(props.onSave);
  const onReadyRef = useRef(props.onReady);
  useEffect(() => {
    onChangeRef.current = props.onChange;
    onSaveRef.current = props.onSave;
    onReadyRef.current = props.onReady;
  });

  useEffect(() => {
    let disposed = false;
    loadMonaco()
      .then((monaco) => {
        if (disposed || !hostRef.current) return;
        const uri = monaco.Uri.parse(`file:///${file}`);
        const model =
          monaco.editor.getModel(uri) ?? monaco.editor.createModel(value, "yaml", uri);
        const editor = monaco.editor.create(hostRef.current, {
          model,
          readOnly,
          theme: "glyph",
          // Stable accessible name: e2e focuses this textbox to edit.
          ariaLabel: "YAML definition",
          // Documents arrive whole (paste, apply normalization); Monaco's
          // auto-indent mangles multi-line inserts (re-indents lines after the
          // first). YAML indentation is explicit in the text.
          autoIndent: "none",
          automaticLayout: true,
          fontSize: 13,
          lineHeight: 19,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: "on",
          tabSize: 2,
          padding: { top: 8, bottom: 8 },
          fixedOverflowWidgets: true,
          renderWhitespace: "selection",
        });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
          onSaveRef.current?.(),
        );
        editor.onDidChangeModelContent(() => onChangeRef.current?.(model.getValue()));
        onReadyRef.current?.({
          revealLine: (line) => {
            editor.revealLineInCenter(line);
            editor.setPosition({ lineNumber: line, column: 1 });
            editor.focus();
          },
        });
        setInstance({ monaco, editor, model });
      })
      .catch(() => setFailed(true));
    return () => {
      disposed = true;
      instance?.model.dispose();
      instance?.editor.dispose();
    };
    // The editor is created once per file; value flows through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // External value changes (initial load, normalization, discard): replace the
  // whole text but keep the cursor on the same line.
  useEffect(() => {
    if (!instance || instance.model.getValue() === value) return;
    const { editor, model } = instance;
    const position = editor.getPosition();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
    if (position) {
      const line = Math.min(position.lineNumber, model.getLineCount());
      editor.setPosition({
        lineNumber: line,
        column: Math.min(position.column, model.getLineMaxColumn(line)),
      });
    }
  }, [instance, value]);

  // Semantic errors → markers on their line (whole line; the backend points at
  // lines, not columns). Owner "glyph" keeps monaco-yaml's own markers intact.
  useEffect(() => {
    if (!instance) return;
    const { monaco, model } = instance;
    const markers: Monaco.editor.IMarkerData[] = [];
    for (const error of props.errors ?? []) {
      if (typeof error.line !== "number" || error.line < 1) continue;
      const line = Math.min(error.line, model.getLineCount());
      markers.push({
        severity: monaco.MarkerSeverity.Error,
        message: error.message,
        startLineNumber: line,
        endLineNumber: line,
        startColumn: 1,
        endColumn: model.getLineMaxColumn(line),
      });
    }
    monaco.editor.setModelMarkers(model, "glyph", markers);
  }, [instance, props.errors]);

  return (
    <div
      data-testid={testid}
      data-state={failed ? "failed" : instance ? "ready" : "loading"}
      className={cn("relative min-h-0 overflow-hidden rounded-md border border-border", className)}
    >
      <div ref={hostRef} className="h-full" aria-label="YAML editor" />
      {!instance && !failed && (
        <div className="absolute inset-0 grid place-items-center bg-surface text-xs text-ink-subtle">
          Loading editor…
        </div>
      )}
      {failed && (
        <div className="absolute inset-0 grid place-items-center bg-surface p-4 text-center text-xs text-danger">
          The editor could not be loaded. Reload the page and try again.
        </div>
      )}
    </div>
  );
}
