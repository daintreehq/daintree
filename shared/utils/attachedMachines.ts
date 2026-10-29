import { pluralize } from "./pluralize.js";

export interface AttachedMachinesCopy {
  /** Every attached machine, one per connection: two Macs with one name are two. */
  count: number;
  /** The machines, for the start of a sentence. */
  subject: string;
  /** The machines, mid-sentence. */
  object: string;
  verb: "is" | "are";
  pronoun: "it" | "them";
  /** "the work it has open" or "the work they have open". */
  openWork: string;
}

// Pinned to English: the sentences around the list are English, and a locale
// joiner would read "MacBook Pro y Studio".
const listFormat = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * The words for a set of attached machines in a warning: names counted rather
 * than merged, so two machines both called "MacBook Pro" read as "2 machines
 * named MacBook Pro", and an unnamed one as "another machine".
 */
export function describeAttachedMachines(names: readonly string[]): AttachedMachinesCopy {
  const named = new Map<string, number>();
  let unnamed = 0;
  for (const raw of names) {
    const name = raw.trim();
    if (name) named.set(name, (named.get(name) ?? 0) + 1);
    else unnamed += 1;
  }

  const parts = [...named].map(([name, n]) =>
    n === 1 ? name : `${n.toLocaleString()} machines named ${name}`
  );
  if (unnamed > 0) {
    parts.push(
      unnamed === 1
        ? "another machine"
        : pluralize(unnamed, "machine", named.size > 0 ? "other machines" : "machines")
    );
  }

  const object = listFormat.format(parts);
  const plural = names.length > 1;
  return {
    count: names.length,
    subject: object.startsWith("another machine") ? `A${object.slice(1)}` : object,
    object,
    verb: plural ? "are" : "is",
    pronoun: plural ? "them" : "it",
    openWork: plural ? "the work they have open" : "the work it has open",
  };
}
