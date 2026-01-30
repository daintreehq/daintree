/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownRenderer } from "../MarkdownRenderer";

describe("MarkdownRenderer", () => {
  describe("basic rendering", () => {
    it("renders plain text", () => {
      render(<MarkdownRenderer content="Hello world" />);
      expect(screen.getByText("Hello world")).toBeDefined();
    });

    it("renders code blocks", () => {
      const { container } = render(
        <MarkdownRenderer content={`\`\`\`javascript\nconst x = 1;\n\`\`\``} />
      );
      const codeElement = container.querySelector("code");
      expect(codeElement).not.toBeNull();
      expect(codeElement?.textContent).toContain("const");
    });

    it("renders multiple paragraphs", () => {
      const { container } = render(
        <MarkdownRenderer content="First paragraph\n\nSecond paragraph" />
      );
      expect(container.textContent).toContain("First paragraph");
      expect(container.textContent).toContain("Second paragraph");
    });
  });

  describe("table rendering", () => {
    it("renders a basic 2x2 table", () => {
      const content = `| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |`;

      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText("Header 1")).toBeDefined();
      expect(screen.getByText("Header 2")).toBeDefined();
      expect(screen.getByText("Cell 1")).toBeDefined();
      expect(screen.getByText("Cell 2")).toBeDefined();
    });

    it("renders a table with multiple rows", () => {
      const content = `| Name | Age |
|------|-----|
| Alice | 30 |
| Bob | 25 |
| Charlie | 35 |`;

      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText("Alice")).toBeDefined();
      expect(screen.getByText("Bob")).toBeDefined();
      expect(screen.getByText("Charlie")).toBeDefined();
    });

    it("renders a table with many columns", () => {
      const content = `| A | B | C | D | E | F |
|---|---|---|---|---|---|
| 1 | 2 | 3 | 4 | 5 | 6 |`;

      render(<MarkdownRenderer content={content} />);

      ["A", "B", "C", "D", "E", "F", "1", "2", "3", "4", "5", "6"].forEach((text) => {
        expect(screen.getByText(text)).toBeDefined();
      });
    });

    it("renders table header row as th elements", () => {
      const content = `| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const thElements = container.querySelectorAll("th");
      expect(thElements.length).toBe(2);
      expect(thElements[0].textContent).toBe("Header 1");
      expect(thElements[1].textContent).toBe("Header 2");
    });

    it("renders table body cells as td elements", () => {
      const content = `| Header |
|--------|
| Cell 1 |
| Cell 2 |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const tdElements = container.querySelectorAll("td");
      expect(tdElements.length).toBe(2);
    });

    it("renders header-only table (no body rows)", () => {
      const content = `| Column A | Column B |
|----------|----------|`;

      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText("Column A")).toBeDefined();
      expect(screen.getByText("Column B")).toBeDefined();
    });
  });

  describe("table alignment", () => {
    it("supports left alignment (default)", () => {
      const content = `| Left |
|:-----|
| text |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const th = container.querySelector("th");
      const td = container.querySelector("td");
      expect(th?.className).toContain("text-left");
      expect(td?.className).toContain("text-left");
    });

    it("supports center alignment", () => {
      const content = `| Center |
|:------:|
| text   |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const th = container.querySelector("th");
      const td = container.querySelector("td");
      expect(th?.className).toContain("text-center");
      expect(td?.className).toContain("text-center");
    });

    it("supports right alignment", () => {
      const content = `| Right |
|------:|
| text  |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const th = container.querySelector("th");
      const td = container.querySelector("td");
      expect(th?.className).toContain("text-right");
      expect(td?.className).toContain("text-right");
    });

    it("supports mixed alignments", () => {
      const content = `| Left | Center | Right |
|:-----|:------:|------:|
| A    | B      | C     |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const thElements = container.querySelectorAll("th");
      expect(thElements[0]?.className).toContain("text-left");
      expect(thElements[1]?.className).toContain("text-center");
      expect(thElements[2]?.className).toContain("text-right");

      const tdElements = container.querySelectorAll("td");
      expect(tdElements[0]?.className).toContain("text-left");
      expect(tdElements[1]?.className).toContain("text-center");
      expect(tdElements[2]?.className).toContain("text-right");
    });
  });

  describe("table with inline formatting", () => {
    it("renders bold text in cells", () => {
      const content = `| Header |
|--------|
| **bold** |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const strong = container.querySelector("strong");
      expect(strong?.textContent).toBe("bold");
    });

    it("renders italic text in cells", () => {
      const content = `| Header |
|--------|
| *italic* |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const em = container.querySelector("em");
      expect(em?.textContent).toBe("italic");
    });

    it("renders inline code in cells", () => {
      const content = `| Header |
|--------|
| \`code\` |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const code = container.querySelector("code");
      expect(code?.textContent).toBe("code");
    });

    it("renders links in cells", () => {
      const content = `| Header |
|--------|
| [link](https://example.com) |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const link = container.querySelector("a");
      expect(link?.textContent).toBe("link");
      expect(link?.getAttribute("href")).toBe("https://example.com");
    });
  });

  describe("edge cases", () => {
    it("handles escaped pipe characters", () => {
      const content = `| Header |
|--------|
| A \\| B |`;

      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText("A | B")).toBeDefined();
    });

    it("handles empty cells", () => {
      const content = `| A | B |
|---|---|
|   | X |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const tdElements = container.querySelectorAll("td");
      expect(tdElements.length).toBe(2);
      expect(tdElements[0].textContent).toBe("");
      expect(tdElements[1].textContent).toBe("X");
    });

    it("handles rows with fewer cells than header", () => {
      const content = `| A | B | C |
|---|---|---|
| 1 |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const tdElements = container.querySelectorAll("td");
      expect(tdElements.length).toBe(3);
    });

    it("handles rows with more cells than header (truncates)", () => {
      const content = `| A | B |
|---|---|
| 1 | 2 | 3 | 4 |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const tdElements = container.querySelectorAll("td");
      expect(tdElements.length).toBe(2);
    });

    it("requires leading pipe for table rows (GFM spec)", () => {
      const content = `Header 1 | Header 2
---------|----------
Cell 1 | Cell 2`;

      const { container } = render(<MarkdownRenderer content={content} />);

      // Should NOT parse as table without leading pipes
      const table = container.querySelector("table");
      expect(table).toBeNull();
    });

    it("handles table without trailing pipe", () => {
      const content = `| Header 1 | Header 2
|----------|----------
| Cell 1 | Cell 2`;

      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText("Header 1")).toBeDefined();
      expect(screen.getByText("Header 2")).toBeDefined();
    });
  });

  describe("table integration with other content", () => {
    it("renders table after text", () => {
      const content = `Some introduction text.

| Header |
|--------|
| Cell   |`;

      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText("Some introduction text.")).toBeDefined();
      expect(screen.getByText("Header")).toBeDefined();
      expect(screen.getByText("Cell")).toBeDefined();
    });

    it("renders table before text", () => {
      const content = `| Header |
|--------|
| Cell   |

Some conclusion text.`;

      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText("Header")).toBeDefined();
      expect(screen.getByText("Cell")).toBeDefined();
      expect(screen.getByText("Some conclusion text.")).toBeDefined();
    });

    it("renders table between code blocks", () => {
      const content = `\`\`\`javascript
const x = 1;
\`\`\`

| Header |
|--------|
| Cell   |

\`\`\`javascript
const y = 2;
\`\`\``;

      const { container } = render(<MarkdownRenderer content={content} />);

      // Code blocks render with syntax highlighting, so use container queries
      const codeElements = container.querySelectorAll("code");
      expect(codeElements.length).toBe(2);
      expect(screen.getByText("Header")).toBeDefined();
      expect(screen.getByText("Cell")).toBeDefined();
    });

    it("renders multiple tables", () => {
      const content = `| Table 1 |
|---------|
| A       |

| Table 2 |
|---------|
| B       |`;

      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText("Table 1")).toBeDefined();
      expect(screen.getByText("Table 2")).toBeDefined();
      expect(screen.getByText("A")).toBeDefined();
      expect(screen.getByText("B")).toBeDefined();
    });

    it("does not parse table-like text inside code blocks", () => {
      const content = `\`\`\`markdown
| Header |
|--------|
| Cell   |
\`\`\``;

      const { container } = render(<MarkdownRenderer content={content} />);

      // Should not render as an actual table
      const table = container.querySelector("table");
      expect(table).toBeNull();
    });
  });

  describe("non-table content should not be parsed as tables", () => {
    it("does not parse text with only pipes as a table", () => {
      const content = `This is a | pipe in text.`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const table = container.querySelector("table");
      expect(table).toBeNull();
    });

    it("does not parse incomplete table structure", () => {
      const content = `| Header |
Not a separator`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const table = container.querySelector("table");
      expect(table).toBeNull();
    });

    it("stops table parsing when encountering non-table line", () => {
      const content = `| Header |
|---------|
| Row 1   |
This is regular text | with a pipe`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const table = container.querySelector("table");
      expect(table).not.toBeNull();

      const rows = container.querySelectorAll("tbody tr");
      expect(rows.length).toBe(1); // Only "Row 1", not the text line
    });

    it("requires at least 3 dashes in separator", () => {
      const content = `| Header |
|--|
| Cell |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const table = container.querySelector("table");
      expect(table).toBeNull(); // Should not parse with only 2 dashes
    });
  });

  describe("security and XSS prevention", () => {
    it("escapes HTML in table cells", () => {
      const content = `| Header |
|---------|
| <script>alert('xss')</script> |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const scriptTag = container.querySelector("script");
      expect(scriptTag).toBeNull();

      const td = container.querySelector("td");
      expect(td?.textContent).toContain("<script>");
    });

    it("escapes HTML in table headers", () => {
      const content = `| <img src=x onerror=alert(1)> |
|---------|
| Cell |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const imgTag = container.querySelector("img");
      expect(imgTag).toBeNull();

      const th = container.querySelector("th");
      expect(th?.textContent).toContain("<img");
    });

    it("sanitizes URLs in links within table cells", () => {
      const content = `| Link |
|------|
| [click](javascript:alert(1)) |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const link = container.querySelector("a");
      // Should not render as a link due to invalid protocol
      expect(link).toBeNull();
    });
  });

  describe("indentation and whitespace handling", () => {
    it("handles indented tables", () => {
      const content = `  | Header |
  |---------|
  | Cell   |`;

      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText("Header")).toBeDefined();
      expect(screen.getByText("Cell")).toBeDefined();
    });

    it("handles tables with extra whitespace around pipes", () => {
      const content = `|  Header  |
|----------|
|  Cell    |`;

      render(<MarkdownRenderer content={content} />);

      expect(screen.getByText("Header")).toBeDefined();
      expect(screen.getByText("Cell")).toBeDefined();
    });
  });

  describe("accessibility", () => {
    it("adds scope attribute to header cells", () => {
      const content = `| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |`;

      const { container } = render(<MarkdownRenderer content={content} />);

      const thElements = container.querySelectorAll("th");
      thElements.forEach((th) => {
        expect(th.getAttribute("scope")).toBe("col");
      });
    });
  });
});
