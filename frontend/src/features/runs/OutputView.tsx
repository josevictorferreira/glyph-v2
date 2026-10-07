// Step output renderers (spec 0020). Agent output is untrusted:
// Markdown goes through rehype-sanitize, HTML only renders in a sandboxed
// iframe pointed at the backend preview route (strict CSP there: the document
// runs in an opaque origin, so scripts have no ambient authority), JSON is
// shown as a tree. Every format offers Raw, Copy and Download.
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { toJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema, type Value } from "@bufbuild/protobuf/wkt";
import { OutputFileFormat, StepKind } from "@/gen/glyph/v1/common_pb";
import type { StepRun } from "@/gen/glyph/v1/run_pb";
import { cn } from "@/shared/lib/cn";
import { CopyButton, Download } from "@/shared/ui";

export function valueToJson(value: Value | undefined): JsonValue | undefined {
  return value ? toJson(ValueSchema, value) : undefined;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="glyph-prose text-sm leading-relaxed text-ink" data-testid="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function JsonTree({ value, depth = 0 }: { value: JsonValue; depth?: number }) {
  if (value === null || typeof value !== "object") {
    return (
      <span
        className={cn(
          "font-mono",
          typeof value === "string" ? "text-status-succeeded" : "text-accent",
        )}
      >
        {JSON.stringify(value)}
      </span>
    );
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) return <span className="font-mono">{open + close}</span>;
  return (
    <details open={depth < 2} className="font-mono text-xs">
      <summary className="cursor-pointer select-none text-ink-muted">
        {open} {entries.length} {entries.length === 1 ? "item" : "items"} {close}
      </summary>
      <ul className="border-l border-border pl-3">
        {entries.map(([key, v]) => (
          <li key={key}>
            <span className="text-ink-muted">{key}: </span>
            <JsonTree value={v} depth={depth + 1} />
          </li>
        ))}
      </ul>
    </details>
  );
}

/** A long value: clipped with expand, plus copy. */
export function ClippedText({ text, mono = true }: { text: string; mono?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 600 || text.split("\n").length > 12;
  return (
    <div className="flex flex-col gap-1">
      <pre
        className={cn(
          "whitespace-pre-wrap break-words rounded-md bg-surface-2 p-2 text-xs text-ink",
          mono ? "font-mono" : "font-sans",
          long && !expanded && "max-h-48 overflow-hidden",
        )}
      >
        {text}
      </pre>
      <div className="flex gap-2">
        {long && (
          <button
            type="button"
            className="text-xs text-accent hover:underline"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Collapse" : "Show all"}
          </button>
        )}
        <CopyButton value={text} className="ml-auto" />
      </div>
    </div>
  );
}

export function StepOutput({ stepRun }: { stepRun: StepRun }) {
  const summary = stepRun.summary;
  const [raw, setRaw] = useState(false);
  const json = valueToJson(stepRun.outputJson);
  const text = stepRun.outputText ?? (json === undefined ? "" : JSON.stringify(json, null, 2));
  const helper = summary?.stepKind === StepKind.HELPER;
  const format = helper
    ? OutputFileFormat.JSON
    : (summary?.outputFileFormat ?? OutputFileFormat.FREE_TEXT_MARKDOWN);

  if (!summary?.hasOutput)
    return <p className="text-xs text-ink-subtle">No output was produced.</p>;

  const zip = format === OutputFileFormat.ZIP;
  let body: React.ReactNode;
  if (zip) {
    body = (
      <div className="flex items-center gap-2 rounded-md border border-border p-3 text-sm">
        <span className="flex-1">{summary.outputName || "output"}.zip</span>
      </div>
    );
  } else if (raw) {
    body = <ClippedText text={text} />;
  } else if (format === OutputFileFormat.HTML && stepRun.previewPath) {
    body = (
      <div className="flex flex-col gap-1">
        <iframe
          title={`${summary.stepName} output preview`}
          src={stepRun.previewPath}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          className="h-96 w-full rounded-md border border-border bg-white"
        />
        <a
          href={stepRun.previewPath}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-accent hover:underline"
        >
          Open in new tab
        </a>
      </div>
    );
  } else if (format === OutputFileFormat.JSON && json !== undefined) {
    body = (
      <div className="rounded-md bg-surface-2 p-2">
        <JsonTree value={json} />
      </div>
    );
  } else {
    body = <Markdown text={text} />;
  }

  return (
    <div className="flex flex-col gap-2" data-testid="step-output">
      {body}
      <div className="flex items-center gap-2">
        {!zip && (
          <button
            type="button"
            className="text-xs text-accent hover:underline"
            onClick={() => setRaw(!raw)}
          >
            {raw ? "Rendered" : "Raw"}
          </button>
        )}
        {!zip && !raw && <CopyButton value={text} />}
        <a
          href={stepRun.downloadPath}
          download
          className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          <Download className="size-3.5" /> Download
        </a>
      </div>
    </div>
  );
}
