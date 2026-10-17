/** Pin locale-less test formatting without changing native constructor/receiver contracts. */
export function installTestLocale(locale: string): () => void {
  const restore: Array<() => void> = [];
  const pick = (locales: unknown): unknown =>
    locales === undefined || (Array.isArray(locales) && locales.length === 0) ? locale : locales;
  const intl = Intl as unknown as Record<string, unknown>;
  for (const name of [
    "Collator",
    "DateTimeFormat",
    "DisplayNames",
    "ListFormat",
    "NumberFormat",
    "PluralRules",
    "RelativeTimeFormat",
    "Segmenter",
  ]) {
    const Original = intl[name] as (new (...args: unknown[]) => object) | undefined;
    if (typeof Original !== "function") continue;
    intl[name] = new Proxy(Original, {
      construct(target, args, newTarget) {
        return Reflect.construct(target, [pick(args[0]), ...args.slice(1)], newTarget);
      },
      apply(target, receiver, args) {
        return Reflect.apply(target, receiver, [pick(args[0]), ...args.slice(1)]);
      },
    });
    restore.push(() => {
      intl[name] = Original;
    });
  }
  const patch = (proto: object, method: string, value: (...args: never[]) => unknown): void => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, method)!;
    Object.defineProperty(proto, method, { ...descriptor, value });
    restore.push(() => {
      Object.defineProperty(proto, method, descriptor);
    });
  };
  const pinMethod = (proto: object, method: string): void => {
    const original = (proto as Record<string, (...args: unknown[]) => unknown>)[method];
    patch(proto, method, function (this: unknown, locales?: unknown, ...rest: unknown[]) {
      return original.call(this, pick(locales), ...rest);
    });
  };
  pinMethod(BigInt.prototype, "toLocaleString");
  pinMethod(Date.prototype, "toLocaleString");
  pinMethod(Date.prototype, "toLocaleDateString");
  pinMethod(Date.prototype, "toLocaleTimeString");

  // Explicit locales allocate on every call; class-name sorting needs a cached collator.
  const numberFormat = new Intl.NumberFormat(locale);
  const numberToLocaleString = Number.prototype.toLocaleString;
  const numberValueOf = Number.prototype.valueOf;
  patch(
    Number.prototype,
    "toLocaleString",
    function (this: unknown, locales?: unknown, options?: Intl.NumberFormatOptions) {
      const value = numberValueOf.call(this);
      if (locales === undefined && options === undefined) return numberFormat.format(value);
      return numberToLocaleString.call(this, pick(locales) as string, options);
    }
  );
  const collator = new Intl.Collator(locale);
  const localeCompare = String.prototype.localeCompare;
  patch(
    String.prototype,
    "localeCompare",
    function (this: unknown, that: string, locales?: unknown, options?: Intl.CollatorOptions) {
      if (this === null || this === undefined)
        throw new TypeError("localeCompare requires a receiver");
      if (locales === undefined && options === undefined)
        return collator.compare(this as string, that);
      return localeCompare.call(this, that, pick(locales) as string, options);
    }
  );
  return () => {
    for (const undo of restore.reverse()) undo();
  };
}
