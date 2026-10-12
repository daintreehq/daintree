/**
 * Text another machine wrote, made safe to show as one line here: C0 and C1
 * controls become spaces, and the Unicode formatting characters that reorder
 * or hide what's around them (bidi overrides and isolates, zero-width marks)
 * are dropped, so a name or title can't flip the text it sits beside.
 */
export function displaySafeText(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- removing control characters is the point
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
  );
}
