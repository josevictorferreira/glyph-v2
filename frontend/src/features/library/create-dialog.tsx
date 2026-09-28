// Create / import / duplicate dialog (spec 0016). One dialog, three tabs.
// Blank → CreateWorkflow; From YAML → debounced ParseDefinition dry run +
// ImportWorkflow; Duplicate → ExportDefinition, strip step ids, rename, import.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTransport } from "@connectrpc/connect-query";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@connectrpc/connect";
import { parseDocument, YAMLMap, YAMLSeq } from "yaml";
import { DefinitionService } from "@/gen/glyph/v1/definition_pb";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import { useWorkflowList, useWorkflowMutation } from "@/features/workflows";
import { YamlEditor } from "@/features/definition";
import { appErrorToast } from "@/shared/api/errors";
import { useDebouncedValue } from "@/shared/lib/use-debounced";
import {
  Button,
  Combobox,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  Textarea,
} from "@/shared/ui";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui";

export type CreateTab = "blank" | "yaml" | "duplicate";

interface CreateDialogApi {
  open: (tab?: CreateTab) => void;
}

const CreateDialogContext = createContext<CreateDialogApi>({ open: () => {} });

/** From features' index: opens the create/import dialog on a given tab. */
export function useCreateWorkflowDialog(): CreateDialogApi {
  return useContext(CreateDialogContext);
}

export function CreateWorkflowDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<CreateTab>("blank");
  const api = useMemo<CreateDialogApi>(
    () => ({
      open: (t?: CreateTab) => {
        if (t) setTab(t);
        setOpen(true);
      },
    }),
    [],
  );
  return (
    <CreateDialogContext value={api}>
      {children}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) return;
          setOpen(false);
          setTab("blank");
        }}
      >
        <DialogContent
          title="New workflow"
          description="Start blank, import a definition, or copy an existing workflow."
          data-testid="create-dialog"
        >
          <Tabs value={tab} onValueChange={(v) => setTab(v as CreateTab)}>
            <TabsList>
              <TabsTrigger value="blank">Blank</TabsTrigger>
              <TabsTrigger value="yaml">From YAML</TabsTrigger>
              <TabsTrigger value="duplicate">Duplicate</TabsTrigger>
            </TabsList>
            <TabsContent value="blank">
              <BlankTab onDone={() => setOpen(false)} />
            </TabsContent>
            <TabsContent value="yaml">
              <YamlTab onDone={() => setOpen(false)} />
            </TabsContent>
            <TabsContent value="duplicate">
              <DuplicateTab onDone={() => setOpen(false)} />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
    </CreateDialogContext>
  );
}

function BlankTab({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const { mutateAsync, isPending } = useWorkflowMutation(WorkflowService.method.createWorkflow, {
    onAppError: appErrorToast,
  });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await mutateAsync({
      name: name.trim(),
      description: description.trim() || undefined,
    });
    onDone();
    const id = res.workflow?.summary?.id;
    if (id) await navigate({ to: "/workflows/$id", params: { id } });
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Name" hint="Optional — defaults to “Untitled workflow”.">
        <Input
          data-testid="create-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Untitled workflow"
        />
      </Field>
      <Field label="Description">
        <Textarea
          data-testid="create-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
      </Field>
      <DialogFooter>
        <Button type="submit" disabled={isPending} data-testid="create-submit">
          {isPending ? "Creating…" : "Create workflow"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function YamlTab({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const transport = useTransport();
  const [yaml, setYaml] = useState("");
  const debounced = useDebouncedValue(yaml, 400);
  const { mutateAsync, isPending } = useWorkflowMutation(DefinitionService.method.importWorkflow, {
    onAppError: appErrorToast,
  });

  // Dry run: parse + reference checks, nothing written.
  const dryRun = useQuery({
    queryKey: ["glyph.v1.DefinitionService", "parseDefinition", debounced],
    queryFn: () => createClient(DefinitionService, transport).parseDefinition({ yaml: debounced }),
    enabled: debounced.trim().length > 0,
    staleTime: Infinity,
    retry: false,
  });
  const errors = dryRun.data?.errors ?? [];

  const onFile = async (file: File | undefined) => {
    if (file) setYaml(await file.text());
  };

  const submit = async () => {
    const res = await mutateAsync({ yaml });
    onDone();
    const id = res.workflow?.summary?.id;
    if (id) await navigate({ to: "/workflows/$id", params: { id } });
  };

  return (
    <div className="space-y-3">
      <Field label="Definition" hint="Paste a workflow definition, or drop / pick a .yml file.">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={async (e) => {
            e.preventDefault();
            await onFile(e.dataTransfer.files[0]);
          }}
        >
          <YamlEditor
            file="import.yml"
            data-testid="create-yaml"
            value={yaml}
            onChange={setYaml}
            errors={errors}
            className="h-56"
          />
        </div>
      </Field>
      <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-accent hover:underline">
        <input
          type="file"
          accept=".yml,.yaml,text/yaml"
          className="hidden"
          onChange={async (e) => onFile(e.target.files?.[0])}
        />
        Choose file…
      </label>
      {debounced.trim().length > 0 && dryRun.isFetching ? (
        <p className="text-xs text-ink-subtle" data-testid="yaml-checking">
          Checking…
        </p>
      ) : errors.length > 0 ? (
        <ul
          data-testid="yaml-errors"
          className="space-y-1 rounded-md border border-danger/40 bg-danger/5 p-2 text-xs text-danger"
        >
          {errors.map((e, i) => (
            <li key={i} className="font-mono">
              {e.line !== undefined && e.line > 0 ? `Line ${e.line}: ` : ""}
              {e.message}
            </li>
          ))}
        </ul>
      ) : dryRun.isSuccess ? (
        <p className="text-xs text-success" data-testid="yaml-valid">
          Definition looks valid.
        </p>
      ) : null}
      <DialogFooter>
        <Button
          onClick={() => void submit()}
          disabled={isPending || yaml.trim().length === 0 || dryRun.isFetching || errors.length > 0}
          data-testid="import-submit"
        >
          {isPending ? "Importing…" : "Import"}
        </Button>
      </DialogFooter>
    </div>
  );
}

function DuplicateTab({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const transport = useTransport();
  const { data } = useWorkflowList({ limit: 100 });
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState(false);
  const source = data?.workflows.find((w) => w.id === sourceId);

  const duplicate = async () => {
    if (!source) return;
    setBusy(true);
    try {
      const definition = createClient(DefinitionService, transport);
      const exported = await definition.exportDefinition({ workflowId: source.id });
      const doc = parseDocument(exported.yaml);
      const steps = doc.get("steps", true);
      if (steps instanceof YAMLSeq) {
        for (const node of steps.items) {
          if (node instanceof YAMLMap) node.delete("id");
        }
      }
      doc.set("name", `${source.name} (copy)`);
      const res = await definition.importWorkflow({ yaml: doc.toString() });
      onDone();
      const id = res.workflow?.summary?.id;
      if (id) await navigate({ to: "/workflows/$id", params: { id } });
    } catch (err) {
      appErrorToast(err as never);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <Field
        label="Workflow to copy"
        hint="The copy starts as a draft with new step ids; the schedule is kept but will not dispatch."
      >
        <Combobox
          ariaLabel="Workflow to copy"
          data-testid="duplicate-source"
          items={(data?.workflows ?? []).map((w) => ({ value: w.id, label: w.name }))}
          value={sourceId || null}
          onValueChange={setSourceId}
          placeholder="Pick a workflow…"
        />
      </Field>
      <DialogFooter>
        <Button
          onClick={() => void duplicate()}
          disabled={busy || !source}
          data-testid="duplicate-submit"
        >
          {busy ? "Copying…" : "Duplicate"}
        </Button>
      </DialogFooter>
    </div>
  );
}
