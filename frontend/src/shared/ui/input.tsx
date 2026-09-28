import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/shared/lib/cn";

const fieldBase =
  "w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-ink " +
  "placeholder:text-ink-subtle focus-visible:border-accent focus-visible:outline-none " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export interface FieldShellProps {
  label?: string;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
  htmlFor?: string;
}

export function Field({ label, hint, error, className, children, htmlFor }: FieldShellProps) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-[0.8125rem] font-medium text-ink-muted">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-xs text-status-failed" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-ink-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, mono, className, id, ...props },
  ref,
) {
  const fallbackId = useId();
  const inputId = id ?? props.name ?? fallbackId;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId}>
      <input
        ref={ref}
        id={inputId}
        className={cn(
          fieldBase,
          "h-8",
          mono && "font-mono",
          error && "border-status-failed",
          className,
        )}
        {...props}
      />
    </Field>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
  mono?: boolean;
  autoGrow?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, mono, autoGrow = true, className, id, onChange, ...props },
  ref,
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const fallbackId = useId();
  const inputId = id ?? props.name ?? fallbackId;

  const resize = () => {
    const el = innerRef.current;
    if (!el || !autoGrow) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 480)}px`;
  };

  useEffect(resize, [props.value, autoGrow]);
  useLayoutEffect(resize, [autoGrow]);

  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId}>
      <textarea
        ref={(el) => {
          innerRef.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        id={inputId}
        rows={props.rows ?? 2}
        onChange={(e) => {
          onChange?.(e);
          resize();
        }}
        className={cn(
          fieldBase,
          "resize-none leading-relaxed",
          mono && "font-mono text-xs",
          error && "border-status-failed",
          className,
        )}
        {...props}
      />
    </Field>
  );
});
