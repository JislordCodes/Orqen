import { Fragment } from "react";

/** Tiny, safe renderer for agent prose: paragraphs, bullets, numbered lists, `code`, **bold**. */
export function Markdownish({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        const isList = lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l) || !l.trim());
        if (isList) {
          const ordered = /^\s*\d+\./.test(lines[0]);
          const Tag = ordered ? "ol" : "ul";
          return (
            <Tag key={i} className={ordered ? "list-decimal space-y-0.5 pl-4" : "list-disc space-y-0.5 pl-4 marker:text-faint"}>
              {lines.filter((l) => l.trim()).map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ""))}</li>)}
            </Tag>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>{j > 0 && <br />}{inline(l)}</Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function inline(s: string) {
  const parts = s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith("`") && p.endsWith("`") ? <code key={i} className="rounded bg-sunk px-1 py-[1px] font-mono text-[0.88em] text-ink">{p.slice(1, -1)}</code>
    : p.startsWith("**") && p.endsWith("**") ? <strong key={i} className="font-semibold text-ink">{p.slice(2, -2)}</strong>
    : <Fragment key={i}>{p}</Fragment>,
  );
}
