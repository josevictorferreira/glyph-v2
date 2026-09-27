// Command registry + ⌘K palette (spec 0016). Features register commands
// through useRegisterCommands(scopeId, commands); the palette aggregates all
// scopes and filters with cmdk. Navigation/global groups are registered here;
// the workspace registers its own scope from its layout route.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { useTransport } from "@connectrpc/connect-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@connectrpc/connect";
import { CatalogService } from "@/gen/glyph/v1/catalog_pb";
import { useWorkflowList } from "@/features/workflows";
import { useCreateWorkflowDialog } from "@/features/library";
import { Dialog, DialogContent } from "@/shared/ui";
import { useTheme } from "./theme";

export interface CommandDef {
  id: string;
  group: string;
  label: string;
  /** Extra fuzzy-match terms. */
  keywords?: string;
  /** Right-aligned hint (e.g. shortcut). */
  hint?: string;
  run: () => void | Promise<void>;
}

interface Registry {
  register(scopeId: string, commands: CommandDef[]): () => void;
  commands: CommandDef[];
}

const RegistryContext = createContext<Registry | null>(null);

/** Register commands for a scope; unregisters on unmount. */
export function useRegisterCommands(scopeId: string, commands: CommandDef[]) {
  const registry = useContext(RegistryContext);
  // Keep register through a ref: the context value changes whenever any scope
  // re-registers, and reacting to that here would loop. The mirror effect runs
  // before the registration effect below.
  const registerRef = useRef(registry?.register);
  useEffect(() => {
    registerRef.current = registry?.register;
  });
  useEffect(() => registerRef.current?.(scopeId, commands), [scopeId, commands]);
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [scopes, setScopes] = useState<Map<string, CommandDef[]>>(new Map());
  const register = useCallback((scopeId: string, scopeCommands: CommandDef[]) => {
    setScopes((prev) => {
      const next = new Map(prev);
      next.set(scopeId, scopeCommands);
      return next;
    });
    return () =>
      setScopes((prev) => {
        if (prev.get(scopeId) !== scopeCommands) return prev; // a newer registration replaced us
        const next = new Map(prev);
        next.delete(scopeId);
        return next;
      });
  }, []);
  const commands = useMemo(() => [...scopes.values()].flat(), [scopes]);
  const value = useMemo<Registry>(() => ({ register, commands }), [register, commands]);

  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <RegistryContext value={value}>
      {children}
      <CommandPalette open={open} onOpenChange={setOpen} commands={commands} />
    </RegistryContext>
  );
}

function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: CommandDef[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Commands" data-testid="command-palette">
        <Command loop className="[&_[cmdk-input]]:w-full [&_[cmdk-input]]:border-b [&_[cmdk-input]]:border-border [&_[cmdk-input]]:bg-transparent [&_[cmdk-input]]:px-3 [&_[cmdk-input]]:py-2.5 [&_[cmdk-input]]:text-sm [&_[cmdk-input]]:outline-none">
          <Command.Input autoFocus placeholder="Type a command or search…" data-testid="command-input" />
          <Command.List className="max-h-80 overflow-y-auto p-1.5">
            <Command.Empty className="px-2 py-6 text-center text-xs text-ink-subtle">No matching commands.</Command.Empty>
            {commands.map((c) => (
              <Command.Item
                key={c.id}
                value={`${c.label} ${c.keywords ?? ""}`}
                onSelect={() => {
                  onOpenChange(false);
                  void c.run();
                }}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm data-[selected=true]:bg-surface-2"
                data-testid={`command-${c.id}`}
              >
                <span className="min-w-0 truncate">
                  <span className="text-ink-subtle">{c.group} · </span>
                  {c.label}
                </span>
                {c.hint && <span className="shrink-0 text-xs text-ink-subtle">{c.hint}</span>}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/** Navigation + global commands; mounted once in the shell. */
export function useAppCommands() {
  const navigate = useNavigate();
  const { data } = useWorkflowList({ limit: 100 });
  const createDialog = useCreateWorkflowDialog();
  const { theme, toggle } = useTheme();
  const transport = useTransport();
  const queryClient = useQueryClient();
  const refreshModels = useMutation({
    mutationFn: () => createClient(CatalogService, transport).refreshModels({}),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  const commands = useMemo<CommandDef[]>(() => {
    const navigation: CommandDef[] = [
      { id: "nav:home", group: "Navigation", label: "Home", hint: "/", run: () => void navigate({ to: "/" }) },
      ...(data?.workflows ?? []).map((w) => ({
        id: `nav:wf-${w.id}`,
        group: "Navigation",
        label: w.name,
        keywords: "workflow open",
        run: () => void navigate({ to: "/workflows/$id", params: { id: w.id } }),
      })),
    ];
    const global: CommandDef[] = [
      { id: "global:new", group: "Global", label: "New workflow", keywords: "create", run: () => createDialog.open("blank") },
      { id: "global:import", group: "Global", label: "Import YAML", keywords: "create", run: () => createDialog.open("yaml") },
      { id: "global:duplicate", group: "Global", label: "Duplicate a workflow", keywords: "copy", run: () => createDialog.open("duplicate") },
      {
        id: "global:refresh-models",
        group: "Global",
        label: "Refresh models",
        keywords: "catalog providers",
        run: () => void refreshModels.mutateAsync(),
      },
      {
        id: "global:theme",
        group: "Global",
        label: `Switch to ${theme === "dark" ? "light" : "dark"} theme`,
        run: toggle,
      },
    ];
    return [...navigation, ...global];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutateAsync is stable in v5; the whole mutation result is not
  }, [data?.workflows, navigate, createDialog, refreshModels.mutateAsync, theme, toggle]);

  useRegisterCommands("nav", commands);
}
