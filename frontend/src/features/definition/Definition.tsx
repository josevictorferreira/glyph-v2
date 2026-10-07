// Definition mode (spec 0021): schema-aware YAML editing of the workflow.
// Export → edit (debounced dry-run) → apply with the fingerprint the edit
// started from. A stale fingerprint opens a diff with three resolutions;
// live WORKFLOW_UPDATED events re-export silently while clean and warn while
// dirty. Leaving with unapplied changes is blocked until confirmed.
//
// Upstream (export) adoption intentionally runs during render (the React
// "adjust state when props change" pattern, as in shared/lib/autosave), so
// the react-hooks/refs rule is disabled for this file.
/* eslint-disable react-hooks/refs */
import { useMemo, useRef, useState } from "react";
import { useTransport } from "@connectrpc/connect-query";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@connectrpc/connect";
import { useBlocker } from "@tanstack/react-router";
import { DefinitionService } from "@/gen/glyph/v1/definition_pb";
import type { ExportDefinitionResponse } from "@/gen/glyph/v1/definition_pb";
import type { DefinitionError, Issue } from "@/gen/glyph/v1/common_pb";
import { EventType } from "@/gen/glyph/v1/live_pb";
import { useWorkflowEvents } from "@/features/live";
import { useWorkflowMutation } from "@/features/workflows";
import { appErrorToast } from "@/shared/api/errors";
import { useDebouncedValue } from "@/shared/lib/use-debounced";
import {
  Badge,
  Button,
  Check,
  Copy,
  Dialog,
  DialogContent,
  DialogFooter,
  Download,
  Eye,
  Pencil,
  toast,
  Trash,
  Upload,
} from "@/shared/ui";
import { YamlEditor, type ExternalError, type YamlEditorApi } from "./YamlEditor";
import { YamlDiff } from "./YamlDiff";
import { ProblemsList, readinessProblems, yamlProblems } from "./problems";

interface Exported {
  yaml: string;
  fingerprint: string;
  filename: string;
}

const toExported = (res: ExportDefinitionResponse): Exported => ({
  yaml: res.yaml,
  fingerprint: res.fingerprint,
  filename: res.filename,
});

export function DefinitionMode({ workflowId }: { workflowId: string }) {
  const transport = useTransport();
  const client = useMemo(() => createClient(DefinitionService, transport), [transport]);
  const [text, setText] = useState<string | null>(null);
  const [base, setBase] = useState<Exported | null>(null);
  const [banner, setBanner] = useState(false);
  const [conflict, setConflict] = useState<Exported | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [applyErrors, setApplyErrors] = useState<DefinitionError[]>([]);
  const [readiness, setReadiness] = useState<Issue[]>([]);
  const editorApiRef = useRef<YamlEditorApi | null>(null);

  const exportQuery = useQuery({
    queryKey: ["glyph.v1.DefinitionService", "exportDefinition", workflowId],
    queryFn: () => client.exportDefinition({ workflowId }),
    enabled: workflowId.length > 0,
  });

  const dirty = text !== null && base !== null && text !== base.yaml;

  // Adopt export data during render: the initial load and every silent
  // re-export while clean; while dirty, a new fingerprint means the workflow
  // changed elsewhere. The seen-fingerprint guard makes adoption
  // idempotent and immune to cached responses older than the base we hold
  // (e.g. right after resolving a conflict from a direct export call).
  const seenFingerprintRef = useRef<string | null>(null);
  const exported = exportQuery.data;
  if (exported && exported.fingerprint !== seenFingerprintRef.current) {
    if (text === null || text === base?.yaml) {
      seenFingerprintRef.current = exported.fingerprint;
      const next = toExported(exported);
      setText(next.yaml);
      setBase(next);
      setBanner(false);
    } else if (exported.fingerprint !== base?.fingerprint && !banner) {
      setBanner(true);
    }
  }
  if (!dirty && banner) setBanner(false);

  const refreshConflict = async () => {
    setConflict(toExported(await client.exportDefinition({ workflowId })));
  };

  // Live updates: refresh the export while the editor follows the server.
  // The conflict view snapshots on open (banner Review or a rejected apply)
  // and re-fetches only if a resolution aborts again — our own successful
  // overwrite also emits WORKFLOW_UPDATED, which must not reopen it.
  useWorkflowEvents((ev) => {
    if (ev.type !== EventType.WORKFLOW_UPDATED) return;
    void exportQuery.refetch();
  });

  // Debounced dry run while dirty; clean text was just blessed by the server.
  const debouncedText = useDebouncedValue(text ?? "", 500);
  const parseQuery = useQuery({
    queryKey: ["glyph.v1.DefinitionService", "parseDefinition", workflowId, debouncedText],
    queryFn: () => client.parseDefinition({ workflowId, yaml: debouncedText }),
    enabled: debouncedText.trim().length > 0 && debouncedText !== base?.yaml,
    staleTime: Infinity,
    retry: false,
  });
  const parseErrors: ExternalError[] = parseQuery.data?.errors ?? [];

  const onChange = (next: string) => {
    setText(next);
    setApplyErrors([]);
  };

  const applyMutation = useWorkflowMutation(DefinitionService.method.applyDefinition, {
    onSucceeded: (res, req) => {
      setApplyErrors([]);
      setReadiness(res.issues);
      setBase({
        yaml: req.yaml ?? "",
        fingerprint: res.newFingerprint,
        filename: base?.filename ?? "workflow.yml",
      });
      toast({ title: "Applied", tone: "success" });
      // Re-export so the editor shows the server's canonical formatting.
      void exportQuery.refetch();
    },
    onAppError: (app) => {
      if (app.kind === "invalid") {
        setApplyErrors(app.definitionErrors);
      } else if (app.kind === "conflict") {
        void refreshConflict().then(() => setBanner(false));
      } else {
        appErrorToast(app);
      }
    },
  });

  const applyWith = async (fingerprint: string) => {
    if (text === null) return;
    try {
      await applyMutation.mutateAsync({ workflowId, yaml: text, fingerprint });
      return true;
    } catch {
      return false; // reported through onAppError
    }
  };

  // Conflict resolutions (spec 0021).
  const keepMine = () => {
    if (!conflict) return;
    setBase(conflict); // next apply starts from the latest fingerprint
    setConflict(null);
  };
  const discardMine = () => {
    if (!conflict) return;
    setBase(conflict);
    setText(conflict.yaml);
    setConflict(null);
  };

  const download = () => {
    if (text === null) return;
    const blob = new Blob([text], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = base?.filename ?? "workflow.yml";
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const copy = async () => {
    if (text === null) return;
    await navigator.clipboard.writeText(text);
    toast({ title: "Definition copied", tone: "success" });
  };

  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !conflict,
    enableBeforeUnload: dirty,
    withResolver: true,
  });

  // Dry-run and a rejected apply can report the same error; show it once.
  const semanticErrors: ExternalError[] = [...parseErrors, ...applyErrors].filter(
    (error, i, all) =>
      all.findIndex((other) => other.message === error.message && other.line === error.line) === i,
  );

  const rows = [...yamlProblems(semanticErrors), ...readinessProblems(readiness)];

  if (exportQuery.isError) {
    return (
      <div className="grid h-full place-items-center p-6 text-sm text-danger">
        The definition could not be loaded. Try reloading the page.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="definition-mode">
      <header
        data-testid="definition-toolbar"
        className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3"
      >
        <span className="text-xs font-medium text-ink-muted">Definition YAML</span>
        <Badge
          tone={dirty ? "warning" : "neutral"}
          data-testid="definition-dirty"
          className="uppercase"
        >
          {dirty ? "Edited" : "Clean"}
        </Badge>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="primary"
            size="sm"
            data-testid="apply-changes"
            loading={applyMutation.isPending}
            disabled={text === null || conflict !== null}
            onClick={() => void applyWith(base?.fingerprint ?? "")}
          >
            <Check className="size-3.5" /> Apply changes
          </Button>
          <Button variant="ghost" size="sm" data-testid="download-yml" onClick={download}>
            <Download className="size-3.5" /> Download .yml
          </Button>
          <Button variant="ghost" size="sm" data-testid="copy-yaml" onClick={() => void copy()}>
            <Copy className="size-3.5" /> Copy
          </Button>
        </div>
      </header>

      {banner && !conflict && (
        <div
          data-testid="definition-changed-elsewhere"
          className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-xs text-ink"
        >
          <span>This workflow changed elsewhere.</span>
          <Button
            variant="ghost"
            size="sm"
            data-testid="definition-review"
            onClick={() => void refreshConflict()}
          >
            <Eye className="size-3.5" /> Review changes
          </Button>
        </div>
      )}

      {conflict ? (
        <section
          data-testid="definition-conflict"
          className="flex min-h-0 flex-1 flex-col gap-2 p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-medium text-ink">
                Your edits conflict with a newer version
              </h2>
              <p className="text-xs text-ink-subtle">
                Left: latest version on the server. Right: your edits.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                data-testid="conflict-keep-mine"
                onClick={keepMine}
              >
                <Pencil className="size-3.5" /> Keep editing on top of latest
              </Button>
              <Button
                variant="secondary"
                size="sm"
                data-testid="conflict-discard"
                onClick={discardMine}
              >
                <Trash className="size-3.5" /> Discard my changes
              </Button>
              <Button
                variant="danger"
                size="sm"
                data-testid="conflict-overwrite"
                onClick={() => setConfirmOverwrite(true)}
              >
                <Upload className="size-3.5" /> Overwrite latest…
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-border">
            <YamlDiff original={conflict.yaml} modified={text ?? ""} />
          </div>
        </section>
      ) : (
        <>
          <div className="min-h-0 flex-1 p-3">
            {text === null ? (
              <div className="h-full w-full animate-pulse rounded-md bg-surface-2" />
            ) : (
              <YamlEditor
                file="workflow.yml"
                data-testid="definition-editor"
                className="h-full"
                value={text}
                onChange={onChange}
                errors={semanticErrors}
                onSave={() => void applyWith(base?.fingerprint ?? "")}
                onReady={(api) => {
                  editorApiRef.current = api;
                }}
              />
            )}
          </div>
          {rows.length > 0 && (
            <section
              data-testid="definition-problems-panel"
              className="shrink-0 border-t border-border bg-surface"
            >
              <div className="border-b border-border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
                Problems · {rows.length}
              </div>
              <div className="max-h-44 overflow-y-auto">
                <ProblemsList
                  rows={rows}
                  onJump={(line) => editorApiRef.current?.revealLine(line)}
                />
              </div>
            </section>
          )}
        </>
      )}

      {confirmOverwrite && conflict && (
        <Dialog open onOpenChange={(open) => !open && setConfirmOverwrite(false)}>
          <DialogContent title="Overwrite the latest version?" data-testid="overwrite-dialog">
            <p className="text-sm text-ink-muted">
              Your text will replace the latest version on the server. Anything changed elsewhere is
              lost.
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmOverwrite(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                data-testid="overwrite-confirm"
                onClick={() => {
                  setConfirmOverwrite(false);
                  void applyWith(conflict.fingerprint).then((ok) => {
                    if (ok) setConflict(null);
                  });
                }}
              >
                <Upload className="size-3.5" /> Overwrite latest
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {blocker.status === "blocked" && (
        <Dialog open onOpenChange={(open) => !open && blocker.reset?.()}>
          <DialogContent title="Discard unapplied changes?" data-testid="definition-blocker">
            <p className="text-sm text-ink-muted">
              You edited the definition without applying it. Leaving now discards those edits.
            </p>
            <DialogFooter>
              <Button
                variant="ghost"
                data-testid="definition-blocker-stay"
                onClick={() => blocker.reset?.()}
              >
                <Pencil className="size-3.5" /> Keep editing
              </Button>
              <Button
                variant="danger"
                data-testid="definition-blocker-leave"
                onClick={() => blocker.proceed?.()}
              >
                <Trash className="size-3.5" /> Discard and leave
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
