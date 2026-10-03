// How a DataTable `numeric` column draws a number cell, and its sums. Pure,
// so the formatting is tested without a table.

export interface NumericFormat {
  currency: string | undefined;
  decimals: number | undefined;
  negative: "minus" | "parens";
}

const MINUS = "−";
const MAX_DECIMALS = 20;

function isCurrency(code: string): boolean {
  if (!/^[A-Za-z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat(undefined, { style: "currency", currency: code });
    return true;
  } catch {
    return false;
  }
}

/** A column's `numeric` object read from untyped plugin input; anything else is `null`. */
export function readNumericFormat(value: unknown): NumericFormat | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const currency: unknown = Reflect.get(value, "currency");
  const decimals: unknown = Reflect.get(value, "decimals");
  const negative: unknown = Reflect.get(value, "negative");
  return {
    currency: typeof currency === "string" && isCurrency(currency) ? currency : undefined,
    decimals:
      typeof decimals === "number" &&
      Number.isInteger(decimals) &&
      decimals >= 0 &&
      decimals <= MAX_DECIMALS
        ? decimals
        : undefined,
    negative: negative === "parens" ? "parens" : "minus",
  };
}

const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(format: NumericFormat, locale: string | undefined): Intl.NumberFormat {
  const key = `${locale ?? ""}|${format.currency ?? ""}|${format.decimals ?? ""}`;
  const cached = formatters.get(key);
  if (cached) return cached;
  // `exceptZero` decides the sign after rounding, so a figure that rounds to
  // zero is unsigned; the plus sign it adds is dropped when drawing.
  const options: Intl.NumberFormatOptions = format.currency
    ? { style: "currency", currency: format.currency, signDisplay: "exceptZero" }
    : { maximumFractionDigits: 2, signDisplay: "exceptZero" };
  if (format.decimals !== undefined) {
    options.minimumFractionDigits = format.decimals;
    options.maximumFractionDigits = format.decimals;
  }
  const created = new Intl.NumberFormat(locale, options);
  formatters.set(key, created);
  return created;
}

/**
 * A figure in the user's locale. A negative one takes a true minus sign or
 * brackets; one that rounds to zero is drawn unsigned, never as "−0".
 */
export function formatNumeric(value: number, format: NumericFormat, locale?: string): string {
  if (!Number.isFinite(value)) return String(value);
  const parts = formatterFor(format, locale)
    .formatToParts(value)
    .filter((part) => part.type !== "plusSign");
  if (!parts.some((part) => part.type === "minusSign")) {
    return parts.map((part) => part.value).join("");
  }
  if (format.negative === "parens") {
    const body = parts
      .filter((part) => part.type !== "minusSign")
      .map((part) => part.value)
      .join("")
      .trim();
    return `(${body})`;
  }
  return parts.map((part) => (part.type === "minusSign" ? MINUS : part.value)).join("");
}

/** The decimal places a number's shortest representation has: 2 for 0.25, 11 for 1e-11. */
function fractionDigits(value: number): number {
  const [mantissa = "", exponent = "0"] = String(value).split("e");
  const point = mantissa.indexOf(".");
  const places = point < 0 ? 0 : mantissa.length - point - 1;
  return Math.max(0, places - Number(exponent));
}

/**
 * The sum of a field's finite numbers over `rows`, `null` when none is a
 * number. Compensated (Neumaier), then rounded to the most decimal places any
 * one of them has, so 0.1 + 0.2 is 0.3 and a large figure does not swallow a
 * small one.
 */
export function sumField(rows: readonly unknown[], id: string): number | null {
  let total = 0;
  let carry = 0;
  let places = 0;
  let found = false;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const value: unknown = Reflect.get(row, id);
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    found = true;
    const next = total + value;
    carry += Math.abs(total) >= Math.abs(value) ? total - next + value : value - next + total;
    total = next;
    places = Math.max(places, fractionDigits(value));
  }
  if (!found) return null;
  const sum = total + carry;
  return places > MAX_DECIMALS ? sum : Number(sum.toFixed(places));
}
