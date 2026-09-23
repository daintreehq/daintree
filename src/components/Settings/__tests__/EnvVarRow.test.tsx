// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EnvVarRow, validateEnvRows, type EnvVarDraft } from "../EnvVarRow";

const row = (id: string, key: string, value = ""): EnvVarDraft => ({ id, key, value });

describe("validateEnvRows", () => {
  it("accepts every name a POSIX shell would export", () => {
    const rows = [row("a", "PATH"), row("b", "_private"), row("c", "node_env2"), row("d", "X")];
    expect(validateEnvRows(rows)).toEqual({});
  });

  it("rejects a name the shell would reject, whatever else the row holds", () => {
    const bad = ["2FAST", "MY-KEY", "has space", "dot.name", "é"];
    for (const key of bad) {
      expect(Object.keys(validateEnvRows([row("r", key, "value")]))).toEqual(["r"]);
    }
  });

  it("flags only the later rows of a duplicated name, never the first", () => {
    const errors = validateEnvRows([row("a", "API"), row("b", "OTHER"), row("c", " API ")]);
    expect(Object.keys(errors)).toEqual(["c"]);
  });

  it("gives an invalid name and a duplicate different messages", () => {
    const errors = validateEnvRows([row("a", "2X"), row("b", "OK"), row("c", "OK")]);
    expect(errors.a).toBeTruthy();
    expect(errors.c).toBeTruthy();
    expect(errors.a).not.toBe(errors.c);
  });

  it("leaves blank rows alone — they are dropped on save, not fixed", () => {
    expect(validateEnvRows([row("a", ""), row("b", "   ")])).toEqual({});
  });
});

describe("EnvVarRow", () => {
  const noop = () => {};
  const renderRow = (props: Partial<Parameters<typeof EnvVarRow>[0]> = {}) =>
    render(
      <EnvVarRow
        row={row("r1", "API_TOKEN", "secret")}
        position={1}
        sensitive={false}
        revealed={false}
        onToggleReveal={noop}
        onKeyChange={noop}
        onValueChange={noop}
        onDelete={noop}
        {...props}
      />
    );

  it("points the name field at its error, so the problem is announced with the field", () => {
    renderRow({ error: "Broken name" });
    const input = screen.getByLabelText("Environment variable name");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    const described = ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    expect(described).toContain("Broken name");
  });

  it("describes nothing and claims nothing invalid when there is no error", () => {
    renderRow();
    const input = screen.getByLabelText("Environment variable name");
    expect(input.getAttribute("aria-invalid")).not.toBe("true");
    expect(input.getAttribute("aria-describedby")).toBeNull();
  });

  it("names its delete action after the variable it deletes", () => {
    const onDelete = vi.fn();
    const { unmount } = renderRow({ onDelete });
    screen.getByRole("button", { name: /API_TOKEN/ }).click();
    expect(onDelete).toHaveBeenCalledTimes(1);
    unmount();
    renderRow({ row: row("r2", "OTHER") });
    expect(screen.queryByRole("button", { name: /API_TOKEN/ })).toBeNull();
    expect(screen.getByRole("button", { name: /OTHER/ })).toBeTruthy();
  });

  it("keeps the storage badge inside the name field rather than ahead of it", () => {
    const { container } = renderRow({ storageBadge: <span data-testid="badge" /> });
    const badge = screen.getByTestId("badge");
    const nameField = screen.getByLabelText("Environment variable name");
    // Same positioned wrapper as the input, so the row's grid columns never move.
    expect(badge.closest("div")).toBe(nameField.parentElement);
    const gridColumns = container.querySelector("[data-env-row] > div")!.children;
    expect(gridColumns[0]).toBe(nameField.parentElement);
  });

  it("masks a sensitive value until it is revealed", () => {
    const { rerender } = renderRow({ sensitive: true });
    const value = screen.getByLabelText("Environment variable value") as HTMLInputElement;
    expect(value.type).toBe("password");
    rerender(
      <EnvVarRow
        row={row("r1", "API_TOKEN", "secret")}
        position={1}
        sensitive
        revealed
        onToggleReveal={noop}
        onKeyChange={noop}
        onValueChange={noop}
        onDelete={noop}
      />
    );
    expect((screen.getByLabelText("Environment variable value") as HTMLInputElement).type).toBe(
      "text"
    );
  });
});
