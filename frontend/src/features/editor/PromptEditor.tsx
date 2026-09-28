// Prompt editor (spec 0018): monospace auto-growing textarea with
// `{{variable}}` highlighting (a backdrop layer mirrors the text), `{{`
// autocomplete over the step's variables, and clickable variable chips that
// insert at the caret. Unknown tokens are underlined; the validator message
// itself renders under the field (backend copy wins).
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/shared/lib/cn";
import { Textarea } from "@/shared/ui";
import { completeToken, openTokenAt, tokenMatches, type Variable } from "./lib/variables";

export interface PromptEditorProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  variables: Variable[];
  /** data-editor-field for readiness deep links. */
  field: string;
  errors?: string[];
  placeholder?: string;
  rows?: number;
  /** Show the clickable variable chips below the editor. */
  chips?: boolean;
}

export function PromptEditor({
  label,
  value,
  onChange,
  onFocus,
  onBlur,
  variables,
  field,
  errors = [],
  placeholder,
  rows = 6,
  chips = true,
}: PromptEditorProps) {
  const listId = useId();
  const inputId = useId();
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const backdrop = useRef<HTMLDivElement | null>(null);
  const caret = useRef(value.length);
  const [open, setOpen] = useState<{ query: string; start: number } | null>(null);
  const [active, setActive] = useState(0);

  const known = new Set(variables.map((v) => v.name));
  const suggestions = open
    ? variables.filter((v) => v.name.toLowerCase().startsWith(open.query.trim().toLowerCase()))
    : [];
  const showList = open !== null && suggestions.length > 0;

  const track = () => {
    const el = textarea.current;
    if (!el) return;
    caret.current = el.selectionStart;
    setOpen(openTokenAt(el.value, el.selectionStart));
  };

  const place = (next: string, at: number) => {
    onChange(next);
    caret.current = at;
    requestAnimationFrame(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(at, at);
    });
  };

  const accept = (name: string) => {
    if (!open) return;
    const done = completeToken(value, open.start, caret.current, name);
    setOpen(null);
    place(done.text, done.caret);
  };

  const insert = (name: string) => {
    const at = Math.min(caret.current, value.length);
    const token = `{{${name}}}`;
    place(value.slice(0, at) + token + value.slice(at), at + token.length);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!showList) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      accept(suggestions[Math.min(active, suggestions.length - 1)]!.name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-[0.8125rem] font-medium text-ink-muted">
        {label}
      </label>
      <div className="relative rounded-md bg-surface">
        <div
          ref={backdrop}
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words",
            "rounded-md border border-transparent px-2.5 py-1.5 font-mono text-xs leading-relaxed text-transparent",
          )}
        >
          <Highlighted text={value} known={known} />
          {"\n"}
        </div>
        <Textarea
          ref={textarea}
          id={inputId}
          mono
          rows={rows}
          value={value}
          placeholder={placeholder}
          data-editor-field={field}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${listId}-${active}` : undefined}
          aria-invalid={errors.length > 0 || undefined}
          className={cn("relative bg-transparent", errors.length > 0 && "border-status-failed")}
          onChange={(e) => {
            onChange(e.target.value);
            caret.current = e.target.selectionStart;
            setOpen(openTokenAt(e.target.value, e.target.selectionStart));
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) track();
          }}
          onClick={track}
          onScroll={(e) => {
            if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onFocus={onFocus}
          onBlur={() => {
            setOpen(null);
            onBlur?.();
          }}
        />
        {showList && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Variables"
            className="absolute inset-x-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-lg"
          >
            {suggestions.map((v, i) => (
              <li
                key={v.name}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep textarea focus
                  accept(v.name);
                }}
                className={cn(
                  "flex cursor-default items-center justify-between rounded px-2 py-1 font-mono text-xs",
                  i === active && "bg-surface-2",
                )}
              >
                {v.name}
                <span className="font-sans text-ink-subtle">
                  {v.source === "input" ? "Input" : "Workflow value"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {errors.map((message) => (
        <p key={message} className="text-xs text-status-failed" role="alert">
          {message}
        </p>
      ))}
      {chips && variables.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1"
          aria-label={`Insert a variable into ${label}`}
          role="group"
        >
          {variables.map((v) => (
            <button
              key={v.name}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(v.name)}
              title={v.source === "input" ? "Step input" : "Workflow value"}
              className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[0.6875rem] text-ink-muted hover:text-ink"
            >
              {`{{${v.name}}}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Highlighted({ text, known }: { text: string; known: Set<string> }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const m of tokenMatches(text)) {
    if (m.start > at) parts.push(text.slice(at, m.start));
    parts.push(
      <mark
        key={m.start}
        data-token={m.name}
        data-known={known.has(m.name)}
        className={cn(
          "rounded-sm text-transparent",
          known.has(m.name)
            ? "bg-accent/15"
            : "bg-transparent underline decoration-status-failed decoration-wavy underline-offset-2",
        )}
      >
        {text.slice(m.start, m.end)}
      </mark>,
    );
    at = m.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
