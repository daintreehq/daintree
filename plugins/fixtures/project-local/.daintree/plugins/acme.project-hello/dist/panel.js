/**
 * Built panel view for the `main` view contribution. React is externalised in a
 * real build and served by the host import map; this fixture returns a plain
 * element description so it needs no React at all.
 */
export default function Panel() {
  return { type: "div", props: { children: "Project Hello" }, key: null };
}
