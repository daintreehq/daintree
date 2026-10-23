/// <reference lib="dom" />
/**
 * The fixture's guest entry, written as an author would against
 * `@daintreehq/plugin-sdk/element-picker` (whose `defineElementPickerExtractor`
 * is an identity function, so it is left out here to keep the fixture free of
 * a cross-project import). Reads only what a Lit element exposes without a dev
 * build — its tag — and invents no file or line.
 */
export default function createLitExtractor(providerId: string) {
  return {
    extract(element: Element, phase: "hover" | "selection") {
      const root = element.getRootNode();
      const host = root instanceof ShadowRoot ? root.host : element;
      if (!host.localName.includes("-")) return null;
      return {
        frameworkEvidence: [
          {
            kind: "generic",
            framework: providerId,
            fields: [
              { name: "tag", value: host.localName },
              { name: "phase", value: phase },
            ],
          },
        ],
      };
    },
  };
}
