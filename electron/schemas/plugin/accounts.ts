// Account, connection and service contributions.

import * as semver from "semver";
import { z } from "zod";
import { PLUGIN_SERVICE_MAX_METHODS } from "../../../shared/config/pluginBudgets.js";
import { PLUGIN_CONNECTION_ID_PATTERN } from "../../../shared/utils/pluginConnections.js";
import { refinePluginHttpsUrl } from "./common.js";

/**
 * An endpoint of `contributes.account`. Fixed by the manifest so the host only
 * ever sends a code, a refresh token or an access token where the user can see
 * it would go. No fragment: a token endpoint is POSTed to, and an authorize URL
 * gets its own query appended.
 */
function accountUrlSchema(fieldLabel: string) {
  return z
    .string()
    .max(2048)
    .superRefine((value, ctx) => {
      refinePluginHttpsUrl(value, ctx, fieldLabel);
      if (value.includes("#")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${fieldLabel} must not carry a fragment: "${value}"`,
          params: { errorCode: "account_url_fragment" },
        });
      }
    });
}

/**
 * Where "Connected as …" comes from: a GET with the access token as a bearer,
 * whose JSON response holds the name at `field` (a dotted path such as
 * `"viewer.login"`).
 */
const PluginAccountIdentitySchema = z
  .object({
    url: accountUrlSchema("contributes.account.identity.url"),
    field: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, {
        message: "identity.field must be a dotted path of plain keys, such as viewer.login",
      }),
  })
  .strict();

/** A connection test: a bearer GET to a fixed endpoint, judged by its status alone. */
const PluginAccountTestSchema = z
  .object({ url: accountUrlSchema("contributes.account.test.url") })
  .strict();

const PluginAccountBaseShape = {
  label: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(200).optional(),
  identity: PluginAccountIdentitySchema.optional(),
  test: PluginAccountTestSchema.optional(),
};

/**
 * `contributes.account` — one sign-in the host runs and stores for the plugin.
 * `oauth2` is an authorization-code flow with PKCE (S256) as a public client;
 * `token` is an API token the user pastes. The plugin only ever receives the
 * current access token.
 */
export const PluginAccountContributionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("oauth2"),
      ...PluginAccountBaseShape,
      authorizeUrl: accountUrlSchema("contributes.account.authorizeUrl"),
      tokenUrl: accountUrlSchema("contributes.account.tokenUrl"),
      clientId: z.string().trim().min(1).max(256),
      scopes: z
        .array(
          z
            .string()
            .min(1)
            .max(256)
            .regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/, {
              message: "scopes entries must be single OAuth scope tokens without spaces",
            })
        )
        .max(64)
        .default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("token"),
      ...PluginAccountBaseShape,
    })
    .strict(),
]);

/**
 * One `contributes.connections` entry (#14102): an account declaration plus the
 * id `host.account` and project bindings address it by.
 */
export const PluginConnectionIdSchema = z.string().regex(PLUGIN_CONNECTION_ID_PATTERN, {
  message: "connection ids are 1-32 lowercase letters, digits or dashes, starting with a letter",
});

export const PluginConnectionContributionSchema = z.discriminatedUnion("kind", [
  PluginAccountContributionSchema.options[0].extend({ id: PluginConnectionIdSchema }),
  PluginAccountContributionSchema.options[1].extend({ id: PluginConnectionIdSchema }),
]);

/**
 * `{manifest id}.{local name}`: a service is named under the id of the plugin
 * that provides it, so an import names exactly one plugin (#14105).
 */
const PLUGIN_SERVICE_NAME_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;

const PLUGIN_SERVICE_METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Upper bounds for `contributes.services`, which is an object and so has no MANIFEST_CONTRIBUTION_CAPS entry. */
export const MANIFEST_SERVICE_PROVIDES_CAP = 16;

export const MANIFEST_SERVICE_REQUIRES_CAP = 16;

export const MANIFEST_SERVICE_METHODS_CAP = PLUGIN_SERVICE_MAX_METHODS;

const PluginServiceNameSchema = z.string().max(96).regex(PLUGIN_SERVICE_NAME_PATTERN, {
  message: 'service names are "{plugin id}.{name}", e.g. "acme.jira.issues"',
});

function isCanonicalSemver(value: string): boolean {
  const parsed = semver.parse(value);
  if (!parsed) return false;
  const build = parsed.build.length > 0 ? `+${parsed.build.join(".")}` : "";
  return value === `${parsed.version}${build}`;
}

const uniqueBy =
  <T>(key: (item: T) => string) =>
  (list: T[]): boolean =>
    new Set(list.map(key)).size === list.length;

export const PluginServiceProvideContributionSchema = z
  .object({
    name: PluginServiceNameSchema,
    // Canonical spelling only: `semver.parse` also accepts a leading "v" and
    // surrounding space, which would let two spellings of one version through.
    version: z.string().refine(isCanonicalSemver, {
      message: "version must be a semver version such as 1.0.0",
    }),
    methods: z
      .array(
        z.string().max(64).regex(PLUGIN_SERVICE_METHOD_PATTERN, {
          message: "method names start with a letter and use only letters, digits and _",
        })
      )
      .min(1)
      .max(MANIFEST_SERVICE_METHODS_CAP)
      .refine(
        uniqueBy<string>((method) => method),
        { message: "methods must not repeat an entry" }
      ),
  })
  .strict();

export const PluginServiceRequireContributionSchema = z
  .object({
    name: PluginServiceNameSchema,
    range: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine((value) => semver.validRange(value) !== null, {
        message: "range must be a valid semver range, e.g. ^1.0.0",
      }),
    optional: z.boolean().optional(),
  })
  .strict();

/** `contributes.services` (#14105). Whose names a plugin may use is checked in `superRefine`. */
export const PluginServicesContributionSchema = z
  .object({
    provides: z
      .array(PluginServiceProvideContributionSchema)
      .max(MANIFEST_SERVICE_PROVIDES_CAP)
      .refine(
        uniqueBy<{ name: string }>((entry) => entry.name),
        { message: "services.provides must not repeat a name" }
      )
      .default([]),
    requires: z
      .array(PluginServiceRequireContributionSchema)
      .max(MANIFEST_SERVICE_REQUIRES_CAP)
      .refine(
        uniqueBy<{ name: string }>((entry) => entry.name),
        { message: "services.requires must not repeat a name" }
      )
      .default([]),
  })
  .strict();
