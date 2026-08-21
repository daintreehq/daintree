import { CORE_SCHEMA, mergeTag } from "js-yaml";

/**
 * js-yaml v5 loads with `CORE_SCHEMA`, which omits the `!!merge` tag — a `<<:`
 * key is left as a literal map entry instead of being merged into its parent.
 * v4 resolved it, so any user- or third-party-authored YAML that shares fields
 * through an anchor silently loses them on load.
 *
 * Use this schema wherever we parse YAML we did not write ourselves. It adds
 * merge back and nothing else, so YAML 1.2 scalar rules are untouched: `yes`
 * and `on` stay strings, `012` stays decimal 12, and a bare date stays a string
 * rather than becoming a `Date`. `YAML11_SCHEMA` would restore merge too, but
 * it changes all three of those as well.
 */
export const YAML_MERGE_SCHEMA = CORE_SCHEMA.withTags([mergeTag]);
