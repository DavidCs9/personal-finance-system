import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMarkdown, renderInlineMarkdown } from "./assistant-markdown";

describe("renderInlineMarkdown", () => {
  it("wraps money and bold", () => {
    const html = renderToStaticMarkup(<>{renderInlineMarkdown("Has gastado **$1,234.50** hoy")}</>);
    expect(html).toContain('class="amt"');
    expect(html).toContain("$1,234.50");
    expect(html).toContain("<strong>");
  });
});

describe("AssistantMarkdown", () => {
  it("renders lists and headings without raw markers", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown
        text={"## Cierre\n\n- Restaurantes: **$800.00**\n- Transporte: $120.00\n\nTe quedan $500.00."}
      />,
    );
    expect(html).not.toContain("##");
    expect(html).not.toContain("**");
    expect(html).toContain("<ul");
    expect(html).toContain('class="amt"');
    expect(html).toContain("Cierre");
  });
});
