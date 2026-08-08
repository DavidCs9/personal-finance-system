import { type ReactNode } from "react";

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const MONEY_RE = /\$\s?-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?/g;

const wrapMoney = (raw: string, keyPrefix: string): ReactNode[] => {
  const parts = raw.split(/(\$\s?-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/g);
  return parts.filter(Boolean).map((part, index) => {
    if (MONEY_RE.test(part)) {
      MONEY_RE.lastIndex = 0;
      return (
        <span key={`${keyPrefix}-m${index}`} className="amt">
          {part}
        </span>
      );
    }
    MONEY_RE.lastIndex = 0;
    return <span key={`${keyPrefix}-t${index}`}>{part}</span>;
  });
};

/** Split text into React nodes: money → .amt, **bold**, *italic*, `code`. */
export const renderInlineMarkdown = (raw: string): ReactNode[] => {
  const source = escapeHtml(raw);
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  const parts = source.split(pattern);
  return parts.filter(Boolean).flatMap((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return [<strong key={`b${index}`}>{wrapMoney(part.slice(2, -2), `b${index}`)}</strong>];
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2 && !part.startsWith("**")) {
      return [<em key={`i${index}`}>{wrapMoney(part.slice(1, -1), `i${index}`)}</em>];
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return [<code key={`c${index}`}>{part.slice(1, -1)}</code>];
    }
    return wrapMoney(part, `t${index}`);
  });
};

type Block =
  | { readonly kind: "heading"; readonly level: 2 | 3; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "ul"; readonly items: readonly string[] }
  | { readonly kind: "ol"; readonly items: readonly string[] };

const parseBlocks = (markdown: string): Block[] => {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    const heading = /^(#{2,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length === 2 ? 2 : 3,
        text: heading[2].trim(),
      });
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length) {
        const bullet = /^[-*]\s+(.+)$/.exec((lines[i] ?? "").trim());
        if (!bullet) break;
        items.push(bullet[1].trim());
        i += 1;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length) {
        const numbered = /^\d+[.)]\s+(.+)$/.exec((lines[i] ?? "").trim());
        if (!numbered) break;
        items.push(numbered[1].trim());
        i += 1;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    const paragraph: string[] = [trimmed];
    i += 1;
    while (i < lines.length) {
      const next = (lines[i] ?? "").trim();
      if (!next || /^(#{2,3})\s+/.test(next) || /^[-*]\s+/.test(next) || /^\d+[.)]\s+/.test(next)) {
        break;
      }
      paragraph.push(next);
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }

  return blocks;
};

/** Lightweight markdown for assistant replies — no HTML passthrough. */
export function AssistantMarkdown({ text }: { readonly text: string }) {
  if (!text.trim()) return null;
  const blocks = parseBlocks(text);
  return (
    <div className="assistant-md">
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          const Tag = block.level === 2 ? "h3" : "h4";
          return (
            <Tag key={index} className="assistant-md-heading">
              {renderInlineMarkdown(block.text)}
            </Tag>
          );
        }
        if (block.kind === "ul") {
          return (
            <ul key={index} className="assistant-md-list">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.kind === "ol") {
          return (
            <ol key={index} className="assistant-md-list ordered">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
              ))}
            </ol>
          );
        }
        return (
          <p key={index} className="assistant-md-p">
            {renderInlineMarkdown(block.text)}
          </p>
        );
      })}
    </div>
  );
}
