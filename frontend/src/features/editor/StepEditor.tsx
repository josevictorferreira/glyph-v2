// Step editor (spec 0018): the contextual panel shown while a step is
// selected. Header (kind, name, overflow menu) + tabs with issue dots.
// Every field autosaves through useWorkflowMutation so the cache stays the
// single source of truth.
import { useState } from "react";
import { StepKind } from "@/gen/glyph/v1/common_pb";
import { WorkflowService } from "@/gen/glyph/v1/workflow_pb";
import type { Step, Workflow } from "@/gen/glyph/v1/workflow_pb";
import { useIssues, useWorkflowMutation } from "@/features/workflows";
import { appErrorToast } from "@/shared/api/errors";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
  IconButton,
  Input,
  Layers,
  MenuBars,
  SaveIndicator,
  Sparkle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "@/shared/ui";
import type { EditorFocus, StepEditorTab } from "./chrome";
import { InputsTab } from "./InputsTab";
import { stepTabIssues } from "./issues";
import { useStepDetailsField } from "./step-details";
import { InstructionsTab, ModelTab, OutputTab, SettingsTab, type StepTabProps } from "./StepTabs";

export interface StepEditorProps {
  workflowId: string;
  workflow: Workflow;
  step: Step;
  tab: StepEditorTab;
  onTabChange: (tab: StepEditorTab) => void;
  onSelectStep: (stepId: string | null) => void;
  focus: EditorFocus | null;
}

export function StepEditor({
  workflowId,
  workflow,
  step,
  tab,
  onTabChange,
  onSelectStep,
  focus,
}: StepEditorProps) {
  const issues = useIssues(workflowId).all;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const isPi = step.kind === StepKind.PI;

  const duplicate = useWorkflowMutation(WorkflowService.method.duplicateStep, {
    onSucceeded: (res) => {
      toast({ title: "Duplicated without model, tools and output settings." });
      onSelectStep(res.newStepId);
    },
    onAppError: (error) => toast({ title: appErrorToast(error), tone: "danger" }),
  });
  const deleteStep = useWorkflowMutation(WorkflowService.method.deleteStep, {
    onSucceeded: () => {
      setDeleteOpen(false);
      onSelectStep(null);
    },
    onAppError: (error) => {
      setDeleteOpen(false);
      toast({ title: appErrorToast(error), tone: "danger" });
    },
  });

  const outgoing = workflow.connections.filter((c) => c.sourceStepId === step.id).length;
  const incoming = workflow.connections.filter((c) => c.destinationStepId === step.id).length;
  const removedConnections = outgoing + incoming;

  const tabs: ReadonlyArray<{ value: StepEditorTab; label: string }> = [
    ...(isPi ? [{ value: "instructions" as const, label: "Instructions" }] : []),
    { value: "inputs", label: "Inputs" },
    ...(isPi ? [{ value: "model" as const, label: "Model & tools" }] : []),
    { value: "output", label: "Output" },
    { value: "settings", label: "Settings" },
  ];

  return (
    <div className="flex h-full flex-col" data-testid="step-editor">
      <StepEditorHeader
        workflowId={workflowId}
        step={step}
        onDuplicate={() => duplicate.mutate({ workflowId, stepId: step.id })}
        onDelete={() => setDeleteOpen(true)}
        duplicatePending={duplicate.isPending}
      />

      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value as StepEditorTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="shrink-0">
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
              <TabDot count={stepTabIssues(issues, step, t.value).length} />
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {tabs.map((t) => (
            <TabsContent key={t.value} value={t.value} className="flex flex-col gap-4">
              <TabPanel
                tab={t.value}
                workflowId={workflowId}
                step={step}
                workflow={workflow}
                focus={focus}
              />
            </TabsContent>
          ))}
        </div>
      </Tabs>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent
          title={`Delete “${step.name}”?`}
          description={
            removedConnections > 0
              ? `This also removes ${removedConnections} ${removedConnections === 1 ? "connection" : "connections"}.`
              : undefined
          }
        >
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              data-testid="confirm-delete-step"
              loading={deleteStep.isPending}
              onClick={() => deleteStep.mutate({ workflowId, stepId: step.id })}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TabDot({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      aria-label={`${count} ${count === 1 ? "issue" : "issues"}`}
      className="inline-block size-1.5 rounded-full bg-status-failed"
    />
  );
}

function StepEditorHeader({
  workflowId,
  step,
  onDuplicate,
  onDelete,
  duplicatePending,
}: {
  workflowId: string;
  step: Step;
  onDuplicate: () => void;
  onDelete: () => void;
  duplicatePending: boolean;
}) {
  const field = useStepDetailsField(workflowId, step);
  const isPi = step.kind === StepKind.PI;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <span className="text-ink-subtle" aria-hidden>
        {isPi ? <Sparkle className="size-4" /> : <Layers className="size-4" />}
      </span>
      <Input
        aria-label="Step name"
        data-testid="step-name"
        data-editor-field="name"
        value={field.value.name}
        onChange={(e) => field.setValue({ ...field.value, name: e.target.value })}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
        className="h-7 flex-1 text-sm font-medium"
      />
      <SaveIndicator status={field.status} onRetry={field.retry} />
      <Dropdown>
        <DropdownTrigger asChild>
          <IconButton label="Step actions" size="sm">
            <MenuBars />
          </IconButton>
        </DropdownTrigger>
        <DropdownContent align="end">
          <DropdownItem disabled={duplicatePending} onSelect={onDuplicate}>
            Duplicate
          </DropdownItem>
          <DropdownItem onSelect={onDelete} className="text-status-failed">
            Delete
          </DropdownItem>
        </DropdownContent>
      </Dropdown>
    </div>
  );
}

function TabPanel({ tab, ...props }: { tab: StepEditorTab } & StepTabProps) {
  const Tab = {
    instructions: InstructionsTab,
    inputs: InputsTab,
    model: ModelTab,
    output: OutputTab,
    settings: SettingsTab,
  }[tab];
  // Keyed by step: autosave drafts never leak into another step's fields.
  return <Tab key={props.step.id} {...props} />;
}
