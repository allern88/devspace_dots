# YUNXU TrustBridge MCP official-provider verification

This workflow verifies the locally installed official Codex, Claude, and Google
Antigravity clients without copying provider credentials into DevSpace.

## Security model

The test runner accepts only these targets:

- `codex`
- `claude`
- `antigravity`

Before a provider is shown or started, DevSpace checks known endpoint override
variables. OpenAI endpoints must remain under `openai.com` or `chatgpt.com`,
Anthropic endpoints under `anthropic.com` or `claude.ai`, and Google endpoints
under Google-owned domains. Loopback endpoints are permitted for local
inspection or a local-only gateway. Shared AI gateway variables and unknown
remote hosts are blocked.

The runner does not read browser cookies, access tokens, refresh tokens, or
provider keyring entries. It launches the official local client exactly as an
ordinary DevSpace subagent would. Report files retain only response SHA-256
hashes and byte counts, not model response text.

## Prerequisites

1. Install and sign in to every provider that should be tested.
2. Enable those providers in `~/.devspace/config.jsonc`.
3. Add the project directory to `workspaces.allowedRoots`.
4. Run the commands from the project that the providers should use.

Antigravity requires the official `agy` command. Start `agy` interactively once
to complete Google Sign-In. DevSpace uses its documented stream-JSON headless
mode after that.

## Five-run smoke test

```bash
pnpm test:official-providers
```

Equivalent explicit command:

```bash
pnpm build
pnpm tsx scripts/official-provider-stability.ts \
  --providers codex,claude,antigravity \
  --runs 5 \
  --timeout 300
```

Each run creates a bounded provider task that is instructed not to edit files,
run shell commands, browse the web, or use external tools. It must return a
unique marker. DevSpace then verifies the task status and marker and performs one
continuation turn on the first successful session.

## Thirty-run stability test

```bash
pnpm test:official-providers:stability
```

The default acceptance threshold is `0.966`, corresponding to at least 29
successful runs out of 30. A provider also fails the report when its continuation
check fails.

Useful overrides:

```bash
pnpm tsx scripts/official-provider-stability.ts \
  --providers codex,antigravity \
  --runs 30 \
  --timeout 420 \
  --minimum-success-rate 0.966 \
  --workspace D:/AI-Games/relic-forge \
  --output D:/AI-Tests/yunxu-trustbridge
```

## Reports

The default destination is:

```text
reports/official-provider-stability/
```

It contains:

```text
OFFICIAL_PROVIDER_E2E_REPORT.md
official-provider-results.json
```

The JSON report distinguishes:

- provider not installed or not enabled;
- provider blocked by official-only policy;
- start failure;
- timeout;
- provider execution failure;
- marker mismatch;
- session continuation failure;
- success-rate threshold failure.

## What this test proves

It verifies:

- DevSpace can discover and start the selected provider;
- the provider can complete a real model request;
- the durable DevSpace agent can be waited on;
- the result returns through the local agent daemon;
- provider session continuation works;
- explicit third-party endpoint overrides are rejected;
- no provider response text is written into the report.

## What requires a separate machine-level test

The runner validates configuration and real task behavior, but it is not a
packet capture. Final production acceptance should separately observe outbound
connections during a smoke run and confirm that destinations are limited to:

- official provider domains;
- localhost or loopback;
- an enterprise endpoint explicitly approved by the owner.

Any unknown remote host is a release blocker. Do not treat a provider's presence
on `PATH` as evidence that authentication, model access, quota, or end-to-end
execution is working.
