/// <reference lib="dom" />
/**
 * What an Angular 22 dev build shows the extractor, without Angular in the
 * repo: the three debug functions it publishes as `window.ng` and the
 * `__ngContext__` keys it sets, each answering as `@angular/core` 22.2.3's own
 * does for elements and component instances. `getComponent` throws on a
 * non-element and names only a host's component; `getOwningComponent` names
 * the component whose template declared an element or a component, null for a
 * root, and throws for anything else; `getHostElement` throws for an instance
 * it does not know. Angular keys a view's top-level elements, every host, and
 * the top-level nodes of content it projects, not the elements nested inside
 * them; the keys a real 22.2.3 app set on the same markup are pinned in
 * `angularExtractor.test.ts`.
 *
 * Only the answers are modelled, not how Angular finds them: no embedded
 * views, and `destroy` is a synthetic invalidation rather than a view
 * teardown. Zone and zoneless apps publish the same functions with the same
 * answers: change detection never enters into what they read.
 */

export interface DebugInfo {
  className: string;
  filePath?: string;
  lineNumber?: number;
}

export interface ComponentSpec {
  selector: string;
  /** What `constructor.name` reads: esbuild's dev output prefixes a class it lowers. */
  className: string;
  /** What `ɵsetClassDebugInfo` recorded. Absent from a JIT build. */
  debugInfo?: DebugInfo;
  template: TemplateNode[];
  shadow?: true;
}

export type TemplateNode =
  | { text: string }
  | { projection: true }
  | { tag: string; attrs?: Record<string, string>; children?: TemplateNode[] }
  | {
      component: ComponentSpec;
      attrs?: Record<string, string>;
      /** Content written between the tags, which the component projects. */
      children?: TemplateNode[];
    };

interface Slot {
  nodes: TemplateNode[];
  owner: object | null;
  view: number;
  outer: Slot | null;
}

const CONTEXT_KEY = "__ngContext__";

export class FakeAngular {
  private readonly components = new Map<Element, object>();
  private readonly hosts = new Map<object, Element>();
  private readonly declarers = new Map<object, object | null>();
  private readonly templateOwners = new Map<Element, object | null>();
  private readonly types = new Map<ComponentSpec, new () => object>();
  private views = 0;

  readonly ng = {
    getComponent: (element: unknown): object | null => {
      if (!(element instanceof Element)) throw new Error("Expecting instance of DOM Element");
      return this.components.get(element) ?? null;
    },
    getOwningComponent: (target: unknown): object | null => {
      if (target instanceof Element) return this.templateOwners.get(target) ?? null;
      if (typeof target === "object" && target !== null && this.declarers.has(target)) {
        return this.declarers.get(target)!;
      }
      throw new Error("The provided value must be an instance of a DOM Node");
    },
    getHostElement: (instance: unknown): Element => {
      const host = typeof instance === "object" && instance !== null && this.hosts.get(instance);
      if (!host) throw new TypeError("Cannot read properties of null (reading 'native')");
      return host;
    },
  };

  bootstrap(spec: ComponentSpec, container: Element): Element {
    const host = document.createElement(spec.selector);
    host.setAttribute("ng-version", "22.2.3");
    container.appendChild(host);
    this.templateOwners.set(host, null);
    this.mountComponent(spec, host, null, ++this.views, {
      nodes: [],
      owner: null,
      view: 0,
      outer: null,
    });
    return host;
  }

  /** As destroying a view does: the instance is no longer in the application. */
  destroy(instance: object): void {
    const host = this.hosts.get(instance);
    this.hosts.delete(instance);
    this.declarers.delete(instance);
    if (host) this.components.delete(host);
  }

  instanceOn(host: Element): object {
    const instance = this.components.get(host);
    if (!instance) throw new Error(`no component on ${host.localName}`);
    return instance;
  }

  private typeFor(spec: ComponentSpec): new () => object {
    let type = this.types.get(spec);
    if (type === undefined) {
      type = { [spec.className]: class {} }[spec.className]!;
      Object.defineProperty(type, "ɵcmp", {
        value: { selectors: [[spec.selector]], debugInfo: spec.debugInfo },
      });
      this.types.set(spec, type);
    }
    return type;
  }

  private mountComponent(
    spec: ComponentSpec,
    host: Element,
    declarer: object | null,
    declaringView: number,
    content: Slot
  ): void {
    const instance = new (this.typeFor(spec))();
    this.components.set(host, instance);
    this.hosts.set(instance, host);
    this.declarers.set(instance, declarer);
    (host as unknown as Record<string, unknown>)[CONTEXT_KEY] = declaringView;
    const view = ++this.views;
    const root = spec.shadow ? host.attachShadow({ mode: "open" }) : host;
    for (const node of spec.template) this.render(node, root, instance, view, true, content);
  }

  private render(
    node: TemplateNode,
    into: Node,
    owner: object | null,
    view: number,
    top: boolean,
    slot: Slot
  ): void {
    if ("text" in node) {
      into.appendChild(document.createTextNode(node.text));
      return;
    }
    if ("projection" in node) {
      // Projected nodes stay their declaring template's, and Angular keys the
      // top-level ones with that template's view as it inserts them.
      for (const child of slot.nodes) {
        this.render(child, into, slot.owner, slot.view, true, slot.outer ?? slot);
      }
      return;
    }
    const tag = "component" in node ? node.component.selector : node.tag;
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(node.attrs ?? {})) element.setAttribute(name, value);
    into.appendChild(element);
    this.templateOwners.set(element, owner);
    if ("component" in node) {
      this.mountComponent(node.component, element, owner, view, {
        nodes: node.children ?? [],
        owner,
        view,
        outer: slot,
      });
      return;
    }
    if (top) (element as unknown as Record<string, unknown>)[CONTEXT_KEY] = view;
    for (const child of node.children ?? []) this.render(child, element, owner, view, false, slot);
  }
}
