import type { CanopyModelVariant } from "@shared/types/ipc/canopy";
import { formatModelBytes } from "./CanopyStatusBar";

/**
 * What the choice of model says, in one place: the enable flow, another host's
 * offer and Settings all word it from here, from the publisher's own numbers.
 */

const percent = (x: number) => `${Math.round(x * 100)}%`;

/** One model's own line: what it costs to have, and how fast it reads. */
export function modelDescription(variant: CanopyModelVariant): string {
  const parts = [`${formatModelBytes(variant.downloadBytes)} download`];
  if (variant.bench) parts.push(`about ${variant.bench.msPerScreen} ms a screen on a fast CPU`);
  if (!variant.supported) parts.push("needs a newer version of Daintree");
  return parts.join(" · ");
}

/** A ratio as the comparison says it: one decimal under ten, so 3.5x is never called 4x. */
function times(ratio: number): string {
  const rounded = ratio < 10 ? Math.round(ratio * 10) / 10 : Math.round(ratio);
  return `${rounded}x`;
}

/** How two measured rates compare, said plainly, the larger model's first. */
function against(large: number, small: number): string {
  return `${percent(large)} against ${percent(small)}`;
}

/**
 * How the smallest and the largest model differ, in the publisher's own
 * numbers from real agent screens it never trained on. Says only what the
 * numbers say: a larger model that is no better is not called better.
 */
export function modelComparison(variants: readonly CanopyModelVariant[]): string | null {
  const measured = variants.filter((v) => v.bench !== null && v.supported);
  if (measured.length < 2) return null;
  const small = measured[0]!;
  const large = measured[measured.length - 1]!;
  const a = small.bench!;
  const b = large.bench!;
  const sentences: string[] = [];
  if (a.agentCategory === b.agentCategory && a.agents === b.agents) {
    sentences.push(
      `Both read an agent's state equally well: ${a.agentCategory} of ${a.agents} real agent screens`
    );
  } else {
    sentences.push(
      `${small.name} reads an agent's state right on ${a.agentCategory} of ${a.agents} real agent screens, ${large.name} on ${b.agentCategory} of ${b.agents}`
    );
  }
  const better = b.headline > a.headline && b.options > a.options;
  sentences.push(
    better
      ? `${large.name} picks the line that says most a little more often (${against(b.headline, a.headline)}) and gets a menu's options right more often (${against(b.options, a.options)})`
      : `Picking the line that says most: ${large.name} ${percent(b.headline)}, ${small.name} ${percent(a.headline)}. A menu's options: ${large.name} ${percent(b.options)}, ${small.name} ${percent(a.options)}`
  );
  const size = large.downloadBytes / small.downloadBytes;
  sentences.push(
    `${large.name} is ${size > 0.87 && size < 1.15 ? "about the same download" : size <= 0.87 ? `${times(1 / size)} smaller to download` : `${times(size)} the download`} and about ${times(b.msPerScreen / a.msPerScreen)} the work per screen`
  );
  if (better) sentences.push(`For most people ${small.name} is enough`);
  return `${sentences.join(". ")}.`;
}
