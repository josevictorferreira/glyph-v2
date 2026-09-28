// Monaco diff editor for the definition conflict view (spec 0021): latest
// server export on the left, your text on the right, both read-only — the
// resolutions are explicit actions, not in-place edits.
import { useEffect, useRef } from "react";
import { loadMonaco } from "./monaco-loader";
import { cn } from "@/shared/lib/cn";

export function YamlDiff({
  original,
  modified,
  className,
}: {
  original: string;
  modified: string;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    // inmemory:// URIs are outside the schema's fileMatch, so the diff only
    // colorizes — markers live in the main editor.
    let originalModel: import("monaco-editor").editor.ITextModel | undefined;
    let modifiedModel: import("monaco-editor").editor.ITextModel | undefined;
    let diffEditor: import("monaco-editor").editor.IStandaloneDiffEditor | undefined;
    loadMonaco().then((monaco) => {
      if (disposed || !hostRef.current) return;
      originalModel = monaco.editor.createModel(
        original,
        "yaml",
        monaco.Uri.parse("inmemory://definition/conflict/original"),
      );
      modifiedModel = monaco.editor.createModel(
        modified,
        "yaml",
        monaco.Uri.parse("inmemory://definition/conflict/mine"),
      );
      diffEditor = monaco.editor.createDiffEditor(hostRef.current, {
        readOnly: true,
        originalEditable: false,
        renderSideBySide: true,
        automaticLayout: true,
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: "on",
      });
      diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    });
    return () => {
      disposed = true;
      diffEditor?.dispose();
      originalModel?.dispose();
      modifiedModel?.dispose();
    };
  }, [original, modified]);
  return <div ref={hostRef} className={cn("h-full", className)} aria-label="YAML diff" />;
}
