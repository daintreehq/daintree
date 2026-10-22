import { describe, expect, it } from "vitest";
import { COMPONENT_LIMITS, ComponentChainSchema, type ComponentRecord } from "../index.js";
import { component, creationFrame } from "./fixtures.js";

function chain(
  components: ComponentRecord[],
  nearestId: string | null = components[0]?.componentId ?? null
) {
  return { nearestId, components, truncated: false };
}

describe("ComponentChainSchema", () => {
  /**
   * `<Page>` (a server component) renders `<Layout><Card /></Layout>`: Card's
   * render parent is Layout, but Page created it, so Page is its owner.
   */
  it("keeps owner and render parent apart, including across an RSC server component", () => {
    const page = component("page", {
      environment: "server",
      name: {
        value: "ProductPage",
        extraction: { kind: "runtime-field", field: "_debugInfo[0].name" },
      },
      ownerId: null,
      rootsComplete: true,
    });
    const layout = component("layout", { renderParentId: "page", ownerId: "page" });
    const card = component("card", {
      renderParentId: "layout",
      ownerId: "page",
      rootElementIds: ["el-1"],
      sourceCandidates: [creationFrame()],
    });

    const parsed = ComponentChainSchema.parse(chain([card, layout, page]));
    const byId = new Map(parsed.components.map((record) => [record.componentId, record]));
    expect(byId.get("card")?.renderParentId).toBe("layout");
    expect(byId.get("card")?.ownerId).toBe("page");
    expect(byId.get("page")?.rootElementIds).toEqual([]);
    expect(byId.get("page")?.environment).toBe("server");
  });

  it("tells an unobserved edge from one observed to be absent", () => {
    const parsed = ComponentChainSchema.parse(chain([component("root", { ownerId: null })]));
    const root = parsed.components[0] ?? {};
    expect("ownerId" in root && root.ownerId).toBeNull();
    expect("renderParentId" in root).toBe(false);
  });

  it("accepts an anonymous component and a truncated walk that omits the edges it did not follow", () => {
    const anonymous = component("anon", { name: null });
    expect(
      ComponentChainSchema.safeParse({
        nearestId: "anon",
        components: [anonymous],
        truncated: true,
      }).success
    ).toBe(true);
  });

  it("rejects duplicate ids", () => {
    expect(ComponentChainSchema.safeParse(chain([component("a"), component("a")])).success).toBe(
      false
    );
  });

  it("rejects an edge or a nearest id that names no record", () => {
    expect(
      ComponentChainSchema.safeParse(chain([component("a", { renderParentId: "ghost" })])).success
    ).toBe(false);
    expect(
      ComponentChainSchema.safeParse(chain([component("a", { ownerId: "ghost" })])).success
    ).toBe(false);
    expect(ComponentChainSchema.safeParse(chain([component("a")], "ghost")).success).toBe(false);
  });

  it("rejects a cycle within either relationship", () => {
    expect(
      ComponentChainSchema.safeParse(
        chain([component("a", { renderParentId: "b" }), component("b", { renderParentId: "a" })])
      ).success
    ).toBe(false);
    expect(ComponentChainSchema.safeParse(chain([component("a", { ownerId: "a" })])).success).toBe(
      false
    );
  });

  it("does not mistake an owner edge back down a render edge for a cycle", () => {
    // A renders inside B, but A created B's element: a legitimate shape when children are passed down.
    const result = ComponentChainSchema.safeParse(
      chain([component("a", { renderParentId: "b" }), component("b", { ownerId: "a" })])
    );
    expect(result.success).toBe(true);
  });

  it("bounds records, roots and candidates", () => {
    const many = Array.from({ length: COMPONENT_LIMITS.records + 1 }, (_, i) => component(`c${i}`));
    expect(ComponentChainSchema.safeParse(chain(many)).success).toBe(false);

    const roots = Array.from({ length: COMPONENT_LIMITS.roots + 1 }, (_, i) => `el-${i}`);
    expect(
      ComponentChainSchema.safeParse(
        chain([component("a", { rootElementIds: roots, rootsComplete: false })])
      ).success
    ).toBe(false);

    const candidates = Array.from({ length: COMPONENT_LIMITS.candidates + 1 }, (_, i) =>
      creationFrame(`c-${i}`)
    );
    expect(
      ComponentChainSchema.safeParse(chain([component("a", { sourceCandidates: candidates })]))
        .success
    ).toBe(false);
  });

  it("rejects unknown keys on a record and an environment outside the set", () => {
    expect(
      ComponentChainSchema.safeParse(chain([{ ...component("a"), fiber: {} } as ComponentRecord]))
        .success
    ).toBe(false);
    expect(
      ComponentChainSchema.safeParse(
        chain([{ ...component("a"), environment: "edge" } as unknown as ComponentRecord])
      ).success
    ).toBe(false);
  });
});
