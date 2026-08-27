// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FormGrid, FormRow, FormSection } from "../WorktreeFormLayout";

describe("FormRow label semantics", () => {
  it("names a single control with a real label association", () => {
    render(
      <FormGrid>
        <FormRow label="Base" htmlFor="base-branch">
          <input id="base-branch" />
        </FormRow>
      </FormGrid>
    );

    expect(screen.getByLabelText("Base")).toBe(screen.getByRole("textbox"));
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("names a composite control region as a group when there is no single control to point at", () => {
    render(
      <FormGrid>
        <FormRow label="Mode">
          <input type="radio" name="mode" aria-label="Local" />
          <input type="radio" name="mode" aria-label="Remote" />
        </FormRow>
      </FormGrid>
    );

    const group = screen.getByRole("group", { name: "Mode" });
    expect(group.querySelectorAll("input")).toHaveLength(2);
  });

  it("skips the group wrapper when the control already names itself", () => {
    render(
      <FormGrid>
        <FormRow label="Environment" selfLabelled>
          <div role="radiogroup" aria-label="Environment" />
        </FormRow>
      </FormGrid>
    );

    // Without the skip, the name would be announced twice — once for the
    // wrapper group, once for the radiogroup inside it.
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "Environment" })).toBeTruthy();
  });

  it("renders no hint cell at all when the hint is absent", () => {
    const withoutHint = render(
      <FormGrid>
        <FormRow label="Path" htmlFor="p" hint={null}>
          <input id="p" />
        </FormRow>
      </FormGrid>
    );
    const gridWithout = withoutHint.container.firstElementChild!;

    const withHint = render(
      <FormGrid>
        <FormRow label="Path" htmlFor="q" hint={<span>relative to the repo</span>}>
          <input id="q" />
        </FormRow>
      </FormGrid>
    );
    const gridWith = withHint.container.firstElementChild!;

    // An always-rendered hint cell would eat a grid row and space every field apart.
    expect(gridWithout.children).toHaveLength(2);
    expect(gridWith.children).toHaveLength(3);
  });

  it("spans a section header across both columns instead of taking a rail cell", () => {
    const { container } = render(
      <FormGrid>
        <FormSection title="Branch">
          <FormRow label="Name" htmlFor="n">
            <input id="n" />
          </FormRow>
        </FormSection>
      </FormGrid>
    );

    // Header, then the row's two cells — a wrapper element around the section
    // would give its rows their own columns and break the shared rail.
    const cells = container.firstElementChild!.children;
    expect(cells).toHaveLength(3);
    expect(cells[0]?.textContent).toContain("Branch");
  });

  it("still occupies the label column when a row has no label", () => {
    const { container } = render(
      <FormGrid>
        <FormRow>
          <input />
        </FormRow>
      </FormGrid>
    );

    // Skipping the cell would slide the control into the label column.
    expect(container.firstElementChild!.children).toHaveLength(2);
  });
});
