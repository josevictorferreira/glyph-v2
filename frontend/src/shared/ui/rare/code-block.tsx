// RareUI-inspired CodeBlock (rareui.com) — reimplemented on the Glyph design system.
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/shared/lib/cn";
import { Check, Copy } from "@/shared/ui/icons";

export type CodeTokenType = "plain" | "comment" | "string" | "keyword" | "number";

export interface CodeToken {
  type: CodeTokenType;
  value: string;
}

export interface CodeTheme {
  mode: "dark" | "light";
  background: string;
  headerBg: string;
  border: string;
  text: string;
  muted: string;
  highlightBg: string;
  tokens: {
    comment: string;
    string: string;
    keyword: string;
    number: string;
  };
}

export interface CodeBlockProps {
  code: string;
  language?: string;
  accent?: string;
  mode?: "auto" | "dark" | "light";
  filename?: string;
  showHeader?: boolean;
  showLineNumbers?: boolean;
  showCopyButton?: boolean;
  highlightLines?: number[];
  className?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    const r = parseInt(cleaned.charAt(0) + cleaned.charAt(0), 16);
    const g = parseInt(cleaned.charAt(1) + cleaned.charAt(1), 16);
    const b = parseInt(cleaned.charAt(2) + cleaned.charAt(2), 16);
    return { r, g, b };
  }
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    return { r, g, b };
  }
  // Fallback to default Glyph accent (#5B5BD6)
  return { r: 91, g: 91, b: 214 };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l: l * 100 };
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) {
    h = (gn - bn) / d + (gn < bn ? 6 : 0);
  } else if (max === gn) {
    h = (bn - rn) / d + 2;
  } else {
    h = (rn - gn) / d + 4;
  }
  return { h: (h / 6) * 360, s: s * 100, l: l * 100 };
}

function hslToHex(h: number, s: number, l: number): string {
  const hn = ((h % 360) + 360) % 360;
  const sn = clamp(s, 0, 100) / 100;
  const ln = clamp(l, 0, 100) / 100;

  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;
  if (hn < 60) {
    r = c;
    g = x;
  } else if (hn < 120) {
    r = x;
    g = c;
  } else if (hn < 180) {
    g = c;
    b = x;
  } else if (hn < 240) {
    g = x;
    b = c;
  } else if (hn < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  const toHex = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, "0");

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function resolveMode(mode: "auto" | "dark" | "light"): "dark" | "light" {
  if (mode === "dark" || mode === "light") return mode;
  if (typeof document !== "undefined") {
    const attr = document.documentElement?.dataset?.theme;
    if (attr === "dark" || attr === "light") return attr;
  }
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
  }
  return "dark";
}

export function deriveCodeTheme(
  accent = "#5B5BD6",
  mode: "auto" | "dark" | "light" = "dark",
): CodeTheme {
  const resolved = resolveMode(mode);
  const { r, g, b } = parseHex(accent);
  const { h, s } = rgbToHsl(r, g, b);
  const baseSat = clamp(s, 24, 88);

  if (resolved === "light") {
    return {
      mode: "light",
      background: hslToHex(h, clamp(baseSat * 0.25, 10, 24), 97),
      headerBg: hslToHex(h, clamp(baseSat * 0.28, 12, 26), 93),
      border: hslToHex(h, clamp(baseSat * 0.25, 12, 24), 85),
      text: hslToHex(h, 20, 14),
      muted: hslToHex(h, 14, 46),
      highlightBg: hslToHex(h, clamp(baseSat * 0.65, 35, 75), 90),
      tokens: {
        comment: hslToHex(h, 14, 52),
        string: hslToHex(h, clamp(baseSat * 0.75, 40, 72), 32),
        keyword: hslToHex(h, clamp(baseSat, 55, 88), 44),
        number: hslToHex(h, clamp(baseSat * 0.95, 60, 92), 54),
      },
    };
  }

  return {
    mode: "dark",
    background: hslToHex(h, clamp(baseSat * 0.36, 14, 32), 10),
    headerBg: hslToHex(h, clamp(baseSat * 0.36, 14, 32), 14),
    border: hslToHex(h, clamp(baseSat * 0.3, 12, 28), 22),
    text: hslToHex(h, 18, 94),
    muted: hslToHex(h, 14, 60),
    highlightBg: hslToHex(h, clamp(baseSat * 0.65, 35, 75), 20),
    tokens: {
      comment: hslToHex(h, 18, 56),
      string: hslToHex(h, clamp(baseSat * 0.7, 45, 75), 84),
      keyword: hslToHex(h, clamp(baseSat, 58, 90), 72),
      number: hslToHex(h, clamp(baseSat * 0.95, 65, 95), 64),
    },
  };
}

// Naive gallery-grade tokenizer (no Prism dependency).
// Order of precedence: comments -> strings -> keywords -> numbers.
// Unknown languages render as plain text.
type LangFamily = "js" | "json" | "bash" | "yaml" | "plain";

function normalizeLanguage(language?: string): LangFamily {
  const lang = (language ?? "").trim().toLowerCase();
  if (["js", "jsx", "javascript", "ts", "tsx", "typescript"].includes(lang)) return "js";
  if (lang === "json") return "json";
  if (["bash", "sh", "shell", "zsh"].includes(lang)) return "bash";
  if (["yaml", "yml"].includes(lang)) return "yaml";
  return "plain";
}

const KEYWORDS: Record<Exclude<LangFamily, "plain">, Set<string>> = {
  js: new Set([
    "import",
    "export",
    "from",
    "default",
    "const",
    "let",
    "var",
    "function",
    "return",
    "if",
    "else",
    "for",
    "while",
    "switch",
    "case",
    "break",
    "continue",
    "type",
    "interface",
    "enum",
    "extends",
    "implements",
    "class",
    "new",
    "async",
    "await",
    "try",
    "catch",
    "finally",
    "throw",
    "typeof",
    "keyof",
    "as",
    "in",
    "of",
    "true",
    "false",
    "null",
    "undefined",
    "void",
  ]),
  json: new Set(["true", "false", "null"]),
  bash: new Set([
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "for",
    "in",
    "do",
    "done",
    "while",
    "case",
    "esac",
    "function",
    "return",
    "export",
    "local",
    "echo",
    "exit",
    "cd",
    "ls",
    "pnpm",
    "npm",
    "npx",
    "git",
    "true",
    "false",
  ]),
  yaml: new Set(["true", "false", "null", "yes", "no", "on", "off"]),
};

function pushToken(tokens: CodeToken[], type: CodeTokenType, value: string) {
  if (!value) return;
  const last = tokens[tokens.length - 1];
  if (last && last.type === type) {
    last.value += value;
  } else {
    tokens.push({ type, value });
  }
}

function splitTokensByLine(tokens: CodeToken[]): CodeToken[][] {
  const lines: CodeToken[][] = [[]];
  for (const token of tokens) {
    const parts = token.value.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        lines.push([]);
      }
      const part = parts[i];
      if (part) {
        const currentLine = lines[lines.length - 1];
        if (currentLine) {
          pushToken(currentLine, token.type, part);
        }
      }
    }
  }
  return lines;
}

export function tokenizeCode(code: string, language = "typescript"): CodeToken[][] {
  const family = normalizeLanguage(language);
  if (family === "plain") {
    return code.split("\n").map((line) => (line ? [{ type: "plain", value: line }] : []));
  }

  const keywords = KEYWORDS[family];
  const tokens: CodeToken[] = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    const ch = code.charAt(i);
    const next = code.charAt(i + 1);

    // 1. Comments
    if (family === "js" && ch === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      const sliceEnd = end === -1 ? len : end;
      pushToken(tokens, "comment", code.slice(i, sliceEnd));
      i = sliceEnd;
      continue;
    }
    if (family === "js" && ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const sliceEnd = end === -1 ? len : end + 2;
      pushToken(tokens, "comment", code.slice(i, sliceEnd));
      i = sliceEnd;
      continue;
    }
    if ((family === "bash" || family === "yaml") && ch === "#") {
      const end = code.indexOf("\n", i);
      const sliceEnd = end === -1 ? len : end;
      pushToken(tokens, "comment", code.slice(i, sliceEnd));
      i = sliceEnd;
      continue;
    }

    // 2. Strings
    const isQuote =
      ch === '"' ||
      (family !== "json" && ch === "'") ||
      (family === "js" && ch === "`");
    if (isQuote) {
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        const c = code.charAt(j);
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === quote) {
          j += 1;
          break;
        }
        if (c === "\n" && quote !== "`") {
          break;
        }
        j += 1;
      }
      pushToken(tokens, "string", code.slice(i, j));
      i = j;
      continue;
    }

    // 3. Keywords (identifiers)
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_$-]/.test(code.charAt(j))) {
        j += 1;
      }
      const word = code.slice(i, j);
      pushToken(tokens, keywords.has(word) ? "keyword" : "plain", word);
      i = j;
      continue;
    }

    // 4. Numbers
    if (/[0-9]/.test(ch)) {
      const rest = code.slice(i);
      const match = /^(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
      if (match) {
        pushToken(tokens, "number", match[0]);
        i += match[0].length;
        continue;
      }
    }

    // Plain character
    pushToken(tokens, "plain", ch);
    i += 1;
  }

  return splitTokensByLine(tokens);
}

export function CodeBlock({
  code,
  language = "typescript",
  accent = "#5B5BD6",
  mode = "auto",
  filename,
  showHeader = true,
  showLineNumbers = false,
  showCopyButton = true,
  highlightLines,
  className,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const theme = useMemo(() => deriveCodeTheme(accent, mode), [accent, mode]);
  const lines = useMemo(() => tokenizeCode(code, language), [code, language]);
  const highlightSet = useMemo(() => new Set(highlightLines ?? []), [highlightLines]);

  const handleCopy = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(code).catch(() => {});
    }
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  };

  const copyButton = showCopyButton ? (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy code"}
      style={{
        color: copied ? theme.tokens.keyword : theme.muted,
        borderColor: theme.border,
        backgroundColor: theme.headerBg,
      }}
      className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <AnimatePresence mode="wait" initial={false}>
        {copied ? (
          <motion.span
            key="check"
            initial={reducedMotion ? false : { scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={reducedMotion ? undefined : { scale: 0.6, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 22 }}
            className="inline-flex"
          >
            <Check size={14} />
          </motion.span>
        ) : (
          <motion.span
            key="copy"
            initial={reducedMotion ? false : { scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={reducedMotion ? undefined : { scale: 0.8, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="inline-flex"
          >
            <Copy size={14} />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  ) : null;

  return (
    <div
      style={{
        backgroundColor: theme.background,
        borderColor: theme.border,
        color: theme.text,
      }}
      className={cn("relative overflow-hidden rounded-card border font-mono text-xs", className)}
    >
      {showHeader ? (
        <div
          style={{
            backgroundColor: theme.headerBg,
            borderColor: theme.border,
          }}
          className="flex items-center justify-between gap-2 border-b px-3 py-2"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium" style={{ color: theme.text }}>
              {filename ?? language}
            </span>
            {filename && (
              <span
                className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
                style={{ color: theme.muted, backgroundColor: theme.background }}
              >
                {language}
              </span>
            )}
          </div>
          {copyButton}
        </div>
      ) : (
        copyButton && <div className="absolute top-2 right-2 z-10">{copyButton}</div>
      )}

      <pre className="overflow-x-auto py-3 leading-relaxed">
        <code>
          {lines.map((lineTokens, idx) => {
            const lineNumber = idx + 1;
            const isHighlighted = highlightSet.has(lineNumber);
            return (
              <div
                key={lineNumber}
                data-line={lineNumber}
                data-highlighted={isHighlighted ? "true" : undefined}
                style={isHighlighted ? { backgroundColor: theme.highlightBg } : undefined}
                className="flex min-w-full px-3"
              >
                {showLineNumbers && (
                  <span
                    aria-hidden="true"
                    style={{ color: theme.muted }}
                    className="mr-4 inline-block w-6 shrink-0 select-none text-right"
                  >
                    {lineNumber}
                  </span>
                )}
                <span className="whitespace-pre">
                  {lineTokens.length === 0
                    ? " "
                    : lineTokens.map((token, tIdx) => (
                        <span
                          key={tIdx}
                          style={
                            token.type === "plain"
                              ? undefined
                              : { color: theme.tokens[token.type] }
                          }
                        >
                          {token.value}
                        </span>
                      ))}
                </span>
              </div>
            );
          })}
        </code>
      </pre>
    </div>
  );
}
