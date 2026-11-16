// Shared sanitized Markdown (spec 0024). Agent output is untrusted: Markdown
// goes through rehype-sanitize, so a <script> never renders as HTML.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { cn } from "@/shared/lib/cn";

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("glyph-prose text-sm leading-relaxed text-ink", className)} data-testid="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
