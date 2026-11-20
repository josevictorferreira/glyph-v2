// One tool call card (spec 0024): summary, links to what it touched,
// expandable validation detail, and Revert for definition changes.
import { useState } from "react";
import { toAppError } from "@/shared/api/errors";
import { Link } from "@tanstack/react-router";
import { cn } from "@/shared/lib/cn";
import { useRevertChange } from "./hooks";
import type { ToolCall } from "@/gen/glyph/v1/chat_pb";

export function ToolCard({ chatId, messageId, tool }: { chatId: string; messageId: string; tool: ToolCall }) {
  const [open, setOpen] = useState(false);
  const revert = useRevertChange(chatId, messageId);
  const label = tool.workflowName || tool.workflowId || "the workflow";
  return (
    <div
      className={cn(
        "max-w-[85%] rounded-md border px-3 py-2 text-xs",
        tool.isError ? "border-danger bg-danger-subtle" : "border-border bg-surface",
      )}
      data-testid="tool-card"
    >
      <p className="font-medium">
        {tool.name}
        {tool.isError ? " (failed)" : ""}
      </p>
      <p className="mt-0.5 text-ink-muted">{tool.summary}</p>
      {tool.workflowId ? (
        <Link
          to="/workflows/$id"
          params={{ id: tool.workflowId }}
          className="mt-1 inline-block font-medium underline"
        >
          {label}
        </Link>
      ) : null}
      {tool.runId && tool.workflowId ? (
        <Link
          to="/workflows/$id/runs/$runId"
          params={{ id: tool.workflowId, runId: tool.runId }}
          className="ml-3 inline-block font-medium underline"
        >
          run
        </Link>
      ) : null}
      {tool.detail ? (
        <>
          <button
            type="button"
            className="mt-1 block underline"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            details
          </button>
          {open ? (
            <pre className="mt-1 max-w-xl overflow-x-auto whitespace-pre-wrap text-ink-muted">
              {tool.detail}
            </pre>
          ) : null}
        </>
      ) : null}
      {tool.reverted ? (
        <p className="mt-1 font-medium text-ink-subtle">Reverted</p>
      ) : tool.revertible ? (
        <div className="mt-1">
          <button
            type="button"
            className="underline disabled:text-ink-subtle"
            disabled={revert.isPending}
            onClick={() => revert.mutate()}
          >
            Revert
          </button>
          {revert.isError ? (
            <p role="alert" className="mt-1 text-danger">
              {toAppError(revert.error).message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
