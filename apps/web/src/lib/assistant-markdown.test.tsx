import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AssistantMarkdown,
  expandCollapsedTableLines,
  renderInlineMarkdown,
} from "./assistant-markdown";

describe("renderInlineMarkdown", () => {
  it("wraps money and bold", () => {
    const html = renderToStaticMarkup(<>{renderInlineMarkdown("Has gastado **$1,234.50** hoy")}</>);
    expect(html).toContain('class="amt"');
    expect(html).toContain("$1,234.50");
    expect(html).toContain("<strong>");
  });

  it("wraps approximate money with tilde", () => {
    const html = renderToStaticMarkup(<>{renderInlineMarkdown("Quedan ~$5,836")}</>);
    expect(html).toContain('class="amt"');
    expect(html).toContain("~$5,836");
  });

  it("renders quotes once while React safely escapes HTML characters", () => {
    const html = renderToStaticMarkup(
      <>{renderInlineMarkdown('Dijo "hola" & <script>alert("x")</script>')}</>,
    );

    expect(html).toContain('Dijo &quot;hola&quot; &amp; &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).not.toContain("&amp;quot;");
    expect(html).not.toContain("<script>");
  });
});

describe("expandCollapsedTableLines", () => {
  it("splits a one-line pipe table into rows", () => {
    const lines = expandCollapsedTableLines(
      "| Concepto | Monto | |---|---| | Gasto total | ~$24,164 | | Disponible | ~$5,836 |",
    );
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.some((line) => /---/.test(line))).toBe(true);
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

  it("renders GFM tables and horizontal rules", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown
        text={[
          "| Concepto | Monto |",
          "|---|---|",
          "| Gasto total | ~$24,164 |",
          "| Disponible | ~$5,836 |",
          "",
          "---",
          "",
          "Listo.",
        ].join("\n")}
      />,
    );
    expect(html).toContain("<table");
    expect(html).toContain("assistant-md-table");
    expect(html).toContain("<th");
    expect(html).toContain("Gasto total");
    expect(html).toContain('class="amt"');
    expect(html).toContain("~$24,164");
    expect(html).toContain("<hr");
    expect(html).not.toContain("|---|");
  });

  it("recovers collapsed single-line tables", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown
        text="| Concepto | Monto | |---|---| | Gasto total | ~$24,164 | | Disponible | ~$5,836 |"
      />,
    );
    expect(html).toContain("<table");
    expect(html).toContain("Disponible");
    expect(html).not.toMatch(/\|\s*---/);
  });
});
