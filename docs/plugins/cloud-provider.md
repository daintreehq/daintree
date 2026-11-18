# Implementing a Cloud Provider

A cloud provider lets Daintree create, start, stop and delete machines on someone's own cloud account and use them as hosts: an EC2 instance, a Compute Engine VM, a droplet, a machine from any service with an API. Daintree ships several built in (Boat, Agent 37, DigitalOcean, Google Compute Engine and AWS EC2); an installed plugin can add more without any change to Daintree. This page covers the manifest entry, the implementation the plugin binds in its worker, and what Daintree expects of each call.

## Before you start

- **Installed plugins only.** A plugin with `"scope": "project"` (or an `"instanceMode": "project"` package) can't declare cloud providers: the manifest is refused. A repository must never be able to add something that creates machines on the person's account just by being opened.
- **No new accounts yet.** Until Daintree asks the person's consent before handing a plugin credentials ([#17352](https://github.com/daintreehq/daintree/issues/17352)), a plugin's provider is not offered in **Connect account**, and main refuses to check or connect credentials for it. Everything else on this page works, and is how the provider will run once that consent exists.
- Read `shared/types/pluginCloudProvider.ts` for the contract (`CloudProviderImpl`, the request and answer shapes) and `shared/types/cloudHosts.ts` for the capability vocabulary. When this page and the types disagree, the types win.

## How it fits together

Everything Daintree shows about a provider comes from the manifest, so the provider is registered, and its accounts and machines named, before any of the plugin's code runs. Every call Daintree makes of the provider goes to the implementation the plugin binds during `activate()`, over the worker's message port:

1. Daintree loads the plugin and registers each `contributes.cloudProviders` entry as `{pluginId}.{id}` (for `acme.clouds` and `ec2`, the provider `acme.clouds.ec2`).
2. When a call is needed (checking an account, listing machine types, creating, starting or stopping a machine, reaching its SSH server), Daintree activates the plugin if it isn't running and calls the method its `activate()` bound with `host.registerCloudProvider`.
3. The answer comes back over the port, and Daintree checks its shape before anything reads it.

Daintree, not the plugin, decides when a machine is idle, when to stop it, and when to look for a create that didn't answer. The provider holds no state between calls.

## Manifest entry

```json
{
  "name": "acme.clouds",
  "main": "dist/main.js",
  "contributes": {
    "cloudProviders": [
      {
        "id": "ec2",
        "name": "EC2",
        "description": "Machines on your own AWS account.",
        "apiUrl": "https://ec2.amazonaws.com",
        "apiKeyUrl": "https://console.aws.amazon.com/iam/home#/security_credentials",
        "dashboardUrl": "https://console.aws.amazon.com/ec2/home",
        "docsUrl": "https://docs.aws.amazon.com/ec2/",
        "credentialFields": [
          {
            "id": "accessKeyId",
            "label": "Access key ID",
            "secret": false,
            "input": "single-line",
            "required": true
          },
          {
            "id": "secretAccessKey",
            "label": "Secret access key",
            "secret": true,
            "input": "single-line",
            "required": true
          }
        ],
        "capabilities": {
          "persistence": {
            "kept": "Its EBS volume",
            "lost": "Instance store and memory",
            "retentionDays": null,
            "saveRetryBilled": false,
            "stoppedComputeBilled": false,
            "stoppedStorageBilled": true
          },
          "typicalStartSeconds": 45,
          "lifetime": { "kind": "none" },
          "sshTrust": "confirm-on-first-connect",
          "transport": "direct",
          "tunnel": null,
          "provisioning": {
            "location": "required",
            "image": "required",
            "network": "optional",
            "sshKey": "at-create"
          },
          "deletion": true
        }
      }
    ]
  }
}
```

| Field | Notes |
| --- | --- |
| `id` | The provider's name inside the plugin: lowercase letters and digits joined by single hyphens, at most 32 characters. Registered as `{pluginId}.{id}`; must match the descriptor passed to `host.registerCloudProvider`. |
| `name`, `description` | Shown wherever the provider, its accounts and its machines are named. |
| `apiUrl` | The https origin (no path, query or fragment) the provider's API calls go to. An account is tied to the origin it connected with, and its credentials are handed over only for that origin. |
| `apiKeyUrl`, `dashboardUrl`, `docsUrl` | https links Daintree opens in the system browser: where to create credentials, the provider's console, its docs. |
| `credentialFields` | What connecting an account asks for, in order, 1 to 16 fields. Each is `{ id, label, secret, input, required, help? }`: `input` is `"single-line"`, `"multi-line"` or `"key-file"` (the contents of a file chosen from disk). Secret values are masked as they're typed, kept only in the OS keychain, and never shown again. |
| `capabilities` | What the provider can do, as semantics rather than a bare "supports start": what a stop keeps and loses and what it bills, how long a start takes, how the machine stops by itself (`lifetime`), how its SSH server is reached and trusted, what a create names beyond its size (`provisioning`), and whether machines can be deleted from Daintree. The UI words every promise about a machine from these, never from what one provider happens to do. In `persistence`, `stoppedComputeBilled` says a stopped machine still bills for compute (`stoppedBilling`, optional, says what it bills in your own terms), and `stoppedStorageBilled` says its disk keeps billing on its own; left out, it reads as `false`, a stop that ends billing. |
| `createReplay` | Optional. `"same-key"` (the default) when your `create` is idempotent on `request.idempotencyKey`, so a create whose answer was lost may be sent again with the same key; `"lookup-only"` when your API has no such key and a second send could make a second machine, so Daintree only ever looks for it again. |

A plugin declares at most 8 providers. The manifest is checked when the plugin loads: an id declared twice, credential fields a form couldn't render or keep apart, a non-https link, or an SSH declaration that doesn't add up is a manifest error naming the field.

### SSH

`transport: "direct"` means Daintree dials the address the provider returns. `sshTrust` says where trust in the machine's host key comes from: `"pinned-from-api"` (your API returns the key and Daintree pins it before dialling), `"confirm-on-first-connect"` (the person confirms its fingerprint once), or `"api-or-confirm"` (your API reports the key once it has one, which may lag boot; Daintree trusts it when the machine presents exactly that key, and otherwise the person confirms the fingerprint once).

`transport: "provider-command"` runs your provider's own CLI as ssh's `ProxyCommand`, for machines only reachable through it (AWS Systems Manager, a cloud's IAP tunnel). Declare it in `tunnel`:

```json
"sshTrust": "provider-tunnel",
"transport": "provider-command",
"tunnel": { "command": "aws", "args": ["ssm", "start-session", "--target", "%h"], "installUrl": "https://aws.amazon.com/cli/" }
```

With a tunnel, trust comes from it (`"provider-tunnel"`) or from your API (`"pinned-from-api"`); a key confirmed on first connect, or checked against your API's report (`"api-or-confirm"`), needs a direct transport, and the manifest refuses the combination. `command` is a bare executable name Daintree finds on the person's `PATH`; `args` are plain words, or one of ssh's tokens `%h`, `%p`, `%r` and `%n`, each a whole argument. Nothing else reaches the `ProxyCommand` line. When the command isn't installed, Daintree says so beside the machine and links `installUrl`.

## Implementing it

Bind the provider during `activate()`:

```ts
import type { CloudProviderImpl, PluginHostApi } from "@daintreehq/plugin-sdk";

export async function activate(host: PluginHostApi) {
  const ec2: CloudProviderImpl = {
    async checkCredentials(values, apiUrl, signal) {
      const who = await sts(values, signal).getCallerIdentity();
      return {
        identity: who.Arn,
        scopes: [{ scope: { kind: "personal", id: who.Account, name: who.Account }, active: true }],
      };
    },
    async validate(credentials) {
      return {
        identity: (await sts(credentials.values, credentials.signal).getCallerIdentity()).Arn,
      };
    },
    async catalog(credentials) {
      /* machine types, regions, images, subnets */
    },
    async list(credentials, { label, location }) {
      /* every machine in the scope, or those carrying `label`, in `location` when given */
    },
    async inspect(credentials, resourceId) {
      /* one machine */
    },
    async create(credentials, request) {
      /* idempotent on request.idempotencyKey */
    },
    async start(credentials, resourceId, { lifetimeSeconds }) {
      /* ... */
    },
    async stop(credentials, resourceId) {
      /* ... */
    },
    async rename(credentials, resourceId, name) {
      /* ... */
    },
    async delete(credentials, resourceId) {
      /* ... */
    },
    async sshAccess(credentials, resourceId) {
      return { user: "ubuntu", endpoint: { host: "203.0.113.7", port: 22 }, hostKey: null };
    },
  };
  await host.registerCloudProvider({ id: "ec2" }, ec2);
}
```

Every method except `checkCredentials` takes the account's `credentials` first: `{ values, scopeId, apiUrl, signal }`. `values` is the account's whole credential set keyed by your declared field ids; `scopeId` is the billing scope the person chose (the `scope.id` your `checkCredentials` offered); `apiUrl` is your manifest's `apiUrl`.

| Method | When | Answers |
| --- | --- | --- |
| `checkCredentials(values, apiUrl, signal)` | Before anything is kept, for a new set and a replacement alike | `{ identity, scopes }`: who the credentials sign in as (or null), and the billing scopes they may use, each of kind `personal`, `organization`, `workspace`, `project` or `account` |
| `validate` | When the person checks an account | `{ identity }` |
| `catalog` | When the person creates a machine | machine types, quotas, and the location, image and network choices your `provisioning` says a create takes |
| `list` | Importing a machine, and looking for a create that didn't answer (by the `daintree-binding` label, and the `location` the create was sent to when your create takes one) | machines in the scope |
| `inspect` | Polling a machine's state | the machine, with `asleep: true` when it is stopped because your provider slept it on idle, and `idleSleep: { enabled, idleSeconds }` when you report its idle sleep per machine |
| `create` | Creating a machine | the machine, which may still be starting |
| `start`, `stop` | The person, or Daintree's idle stop | the machine, or null when the provider said nothing about it |
| `renewLifetime` | Moving a running machine's automatic stop; required, and only called, for `lifetime.kind: "renewable"` | the machine |
| `rename`, `delete` | Renaming, and deleting while `capabilities.deletion` is true | nothing |
| `authorizeSsh(credentials, resourceId, publicKey)` | Required for `sshKey: "after-create"`: put the key on the machine | `{ user, endpoint, hostKey }` |
| `sshAccess` | Required for `sshKey: "at-create"`: the key went with `create` (`request.publicKey`), and an imported machine is reached the same way | `{ user, endpoint, hostKey }` |

Main checks the registration against the manifest: an id that isn't declared, or an impl missing a method its declaration needs, is refused, and the plugin's activation fails with that message (in the worker the `await` itself still resolves; the failure is the activation's). It is revoke-guarded: call it during `activate()`. Re-registering the same id replaces the binding. Calls reach the impl only once the activation that bound it has finished: a worker that crashed and is starting again answers nothing until its own `activate()` returns.

### Each call

- **30 seconds, activation included.** A call that takes longer is given up on, and its `signal` aborts. Waiting for a machine to come up is Daintree's job, between calls: answer with the machine as it is, still `starting` if need be.
- **Honour the signal.** It aborts when Daintree stops waiting: the deadline passed, or the person cancelled. Pass it to your HTTP client.
- **Create is idempotent.** A create whose answer was lost is retried with the same `idempotencyKey`, and before it is retried Daintree looks for the machine by the `daintree-binding` label it put in `request.labels`. Keep those labels on the machine, and return the machine you already made when you see a key again. If your API has no idempotency key, declare `"createReplay": "lookup-only"`: Daintree then only ever looks for the machine again, and never sends the create a second time.
- **No state between calls.** The worker may be stopped while idle and started again for the next call, and credentials are handed over for one call at a time. Never keep them.

### Failures

Throw an `Error` whose `code` names what happened, and the person sees your message with Daintree's handling for that code:

```ts
throw Object.assign(new Error("No capacity for t3.large in eu-west-1a"), { code: "capacity" });
```

`credential-invalid`, `permission`, `billing`, `rate-limited`, `capacity`, `ssh-authorization`, `unsupported` and `refused` (the request was turned down as it was made: a size its region lacks, a limit reached) tell Daintree the provider refused and nothing was done, so a refused create is retried with a fresh key. `not-found` says there is no such machine. Any other `CloudHostErrorCode` is kept as given, and a throw without a code reads as `failed`. Keep messages to one line; they're shown as they are, cut at 300 characters.

A crash of the worker, a call that misses its deadline, a plugin that didn't start, or one that started without binding the provider are all reported as `provider-unreachable` on that account or machine, never as a failure of Daintree itself. A create that may have reached the provider is never assumed not to have: it is marked as unconfirmed, and Retry looks for it first.

### What Daintree checks

Your answers cross a process boundary, and Daintree reads only what it can use. A machine without a `resourceId`, with a `machine` state it doesn't know, without real booleans for `dataExpired`, `snapshotsDisabled` and `restricted`, or with an `asleep` or `idleSleep` that isn't the declared shape, a catalog without a list of machine types, or billing scopes without ids are refused as an answer Daintree can't read (`failed`). A field the contract lets be null may be left out and reads as unknown, but one that is there with the wrong shape (a timestamp that doesn't parse, a lifetime that isn't a number, an identity that isn't a string or `null`) fails the whole answer: null means something, such as no deadline, that a malformed value doesn't. Labels beyond the first 64 are dropped, except Daintree's own (`daintree-*`). An answer about a machine other than the one asked about is refused. If an answer can't be serialized, the call fails with no code, so a create that got that far is looked for rather than retried as refused. An SSH address is checked before it's written into any ssh configuration, and a host key is pinned only for `"pinned-from-api"`, and trusted without a confirmation only when the machine presents it under `"api-or-confirm"`. One answer is at most 1 MB.

## When the provider isn't there

Accounts and machines are kept whatever happens to the plugin. While its provider isn't registered, they're listed as unavailable with the reason, and nothing is asked of the provider:

- the plugin is turned off, or Daintree blocked it;
- it failed to load (the message is its load error), or its worker failed to start this session (the message is why; it comes back once the plugin starts again, from Settings → Plugins or anything else that starts it);
- it isn't installed, or a newer version no longer declares the provider.

A plugin that is installed and turned on but not running isn't unavailable: its next call starts it. When the plugin is back, its provider registers again and the accounts and machines pick up where they were, with no new connect.

## Testing

`createMockHost()` records `registerCloudProvider` bindings in `registeredCloudProviders`, so a test can call your impl directly with credentials and a signal of its own. It skips the manifest checks. `electron/services/plugin/__tests__/cloudProviderWorkerBridge.test.ts` drives a sample provider with an in-memory backend through the real worker bridge: check, create, start, stop and delete, a refusal that keeps its code, a crash, and a cancel.
