// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrandMark } from "../BrandMark";

const resolveBrandChipMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/brandIcon", () => ({
  resolveBrandChip: resolveBrandChipMock,
}));
vi.mock("@/hooks/useActiveAppScheme", () => ({
  useActiveAppScheme: () => ({ type: "dark", tokens: {} }),
}));

function TestIcon({ className }: { className?: string }) {
  return <svg data-testid="icon" className={className} />;
}

beforeEach(() => {
  resolveBrandChipMock.mockReset();
});

describe("BrandMark", () => {
  it("forwards className onto the child SVG when no chip is rendered", () => {
    resolveBrandChipMock.mockReturnValue(null);

    const { getByTestId, container } = render(
      <BrandMark className="w-3.5 h-3.5 mr-2">
        <TestIcon />
      </BrandMark>
    );

    expect(container.querySelector("span")).toBeNull();
    expect(getByTestId("icon").getAttribute("class")).toBe("w-3.5 h-3.5 mr-2");
  });

  it("merges existing child className with the BrandMark className", () => {
    resolveBrandChipMock.mockReturnValue(null);

    const { getByTestId } = render(
      <BrandMark className="mr-2">
        <TestIcon className="text-status-info" />
      </BrandMark>
    );

    const cls = getByTestId("icon").getAttribute("class") ?? "";
    expect(cls.split(/\s+/)).toEqual(expect.arrayContaining(["text-status-info", "mr-2"]));
  });

  it("renders bare child unchanged when no className is supplied", () => {
    resolveBrandChipMock.mockReturnValue(null);

    const { getByTestId, container } = render(
      <BrandMark>
        <TestIcon />
      </BrandMark>
    );

    expect(container.querySelector("span")).toBeNull();
    expect(getByTestId("icon").hasAttribute("class")).toBe(false);
  });

  it("applies className to the chip wrapper, not the child, when a chip is returned", () => {
    resolveBrandChipMock.mockReturnValue({ background: "#F5F5F5" });

    const { getByTestId, container } = render(
      <BrandMark className="w-3.5 h-3.5 mr-2">
        <TestIcon />
      </BrandMark>
    );

    const span = container.querySelector("span");
    expect(span).not.toBeNull();
    const spanClass = span?.getAttribute("class") ?? "";
    expect(spanClass).toContain("mr-2");
    expect(getByTestId("icon").hasAttribute("class")).toBe(false);
  });
});
