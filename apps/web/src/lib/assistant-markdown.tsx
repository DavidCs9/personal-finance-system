import { type ReactNode } from "react";

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const MONEY_PART = String.raw`~?\$\s?-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?`;

const wrapMoney = (raw: string, keyPrefix: string): ReactNode[] => {
  const parts = raw.split(new RegExp(`(${MONEY_PART})`, "g"));
  const nodes: ReactNode[] = [];
  for (const [index, part] of parts.entries()) {
    if (!part) continue;
    if (new RegExp(`^${MONEY_PART}$`).test(part)) {
      nodes.push(
        <span key={`${keyPrefix}-m${index}`} className="amt">
          {part}
        </span>,
      );
    } else {
      nodes.push(<span key={`${keyPrefix}-t${index}`}>{part}</span>);
    }
  }
  return nodes;
};

/** Split text into React nodes: money → .amt, **bold**, *italic*, `code`. */
export const renderInlineMarkdown = (raw: string): ReactNode[] => {
  const source = escapeHtml(raw);
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  const parts = source.split(pattern);
  const nodes: ReactNode[] = [];
  for (const [index, part] of parts.entries()) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      nodes.push(<strong key={`b${index}`}>{wrapMoney(part.slice(2, -2), `b${index}`)}</strong>);
      continue;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2 && !part.startsWith("**")) {
      nodes.push(<em key={`i${index}`}>{wrapMoney(part.slice(1, -1), `i${index}`)}</em>);
      continue;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      nodes.push(<code key={`c${index}`}>{part.slice(1, -1)}</code>);
      continue;
    }
    nodes.push(...wrapMoney(part, `t${index}`));
  }
  return nodes;
};

type Block =
  | { readonly kind: "heading"; readonly level: 2 | 3; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "ul"; readonly items: readonly string[] }
  | { readonly kind: "ol"; readonly items: readonly string[] }
  | { readonly kind: "hr" }
  | { readonly kind: "table"; readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[] };

const isTableSeparator = (line: string): boolean =>
  /^\|?[\s:|-]+\|[\s:|-]+/.test(line) && /---/.test(line);

const splitTableRow = (line: string): string[] => {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
};

const looksLikeTableRow = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.includes("|") && splitTableRow(trimmed).length >= 2;
};

/** Recover tables the model collapsed into one line: `| a | b | |---|---| | c | d |`. */
export const expandCollapsedTableLines = (line: string): string[] => {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [line];
  const chunks = trimmed
    .split(/\s*\|\s*\|\s*/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  if (chunks.length < 2) return [line];
  const hasSeparator = chunks.some((chunk) => /^[\s:|-]*---[\s:|-]*$/.test(chunk.replace(/\|/g, "").trim()) || isTableSeparator(`|${chunk}|`));
  if (!hasSeparator && chunks.length < 3) return [line];
  return chunks.map((chunk) => (chunk.startsWith("|") ? chunk : `| ${chunk} |`));
};

const parseBlocks = (markdown: string): Block[] => {
  const rawLines = markdown.replace(/\r\n/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of rawLines) {
    const expanded = expandCollapsedTableLines(line);
    if (expanded.length > 1) lines.push(...expanded);
    else lines.push(line);
  }

  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ kind: "hr" });
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

    if (looksLikeTableRow(trimmed)) {
      const tableLines: string[] = [];
      while (i < lines.length) {
        const candidate = (lines[i] ?? "").trim();
        if (!candidate) break;
        if (!looksLikeTableRow(candidate) && !isTableSeparator(candidate)) break;
        tableLines.push(candidate);
        i += 1;
      }
      const bodyLines = tableLines.filter((row) => !isTableSeparator(row));
      if (bodyLines.length >= 1) {
        const headers = splitTableRow(bodyLines[0] ?? "");
        const rows = bodyLines.slice(1).map(splitTableRow);
        if (headers.length >= 2) {
          blocks.push({ kind: "table", headers, rows });
          continue;
        }
      }
      // Fall through as paragraph if malformed.
      blocks.push({ kind: "paragraph", text: tableLines.join(" ") });
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
      if (
        !next
        || /^(#{2,3})\s+/.test(next)
        || /^[-*]\s+/.test(next)
        || /^\d+[.)]\s+/.test(next)
        || /^(-{3,}|\*{3,}|_{3,})$/.test(next)
        || looksLikeTableRow(next)
      ) {
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
        if (block.kind === "hr") {
          return <hr key={index} className="assistant-md-hr" />;
        }
        if (block.kind === "table") {
          const numericCol = block.headers.length === 2 ? 1 : -1;
          return (
            <div key={index} className="assistant-md-table-wrap">
              <table className="assistant-md-table">
                <thead>
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th
                        key={headerIndex}
                        className={headerIndex === numericCol ? "num" : undefined}
                      >
                        {renderInlineMarkdown(header)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {block.headers.map((_, cellIndex) => (
                        <td
                          key={cellIndex}
                          className={cellIndex === numericCol ? "num" : undefined}
                        >
                          {renderInlineMarkdown(row[cellIndex] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
