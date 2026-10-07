# YUNXU TrustBridge MCP official-provider verification

This workflow verifies the locally installed official Codex, Claude, and Google
automation clients without copying browser sessions or provider refresh tokens
into DevSpace.

## Security model

The test runner accepts only these targets:

- `codex`
- `claude`
- `antigravity`

Before a provider is shown or started, DevSpace checks known endpoint override
variables. OpenAI endpoints must remain under `openai.com` or `chatgpt.com`,
Anthropic endpoints under `anthropic.com` or `claude.ai`, and Google endpoints
under Google-owned domains. Loopback endpoints are permitted for local
inspection or a local-only gateway. Remote endpoints must use HTTPS and may not
contain embedded usernames or passwords. Shared AI gateway variables and
unknown remote hosts are blocked.

The runner does not read browser cookies, access tokens, refresh tokens, or
provider keyring entries. Report files retain only response SHA-256 hashes and
byte counts, not model response text.

## Google automation policy

Do not use a personal Antigravity or Google AI Pro login through DevSpace.
Google's current terms and FAQ prohibit third-party coding agents from reusing
personal Antigravity OAuth. DevSpace therefore exposes the `antigravity`
provider only when exactly one approved automation mode is configured.

### Google AI Studio API key

The official CLI requires both an API key and an explicit Gemini provider
selection. Create or update:

```text
~/.gemini/antigravity-cli/settings.json
```

```json
{
  "modelProvider": "gemini"
}
```

Then inject `GEMINI_API_KEY` into the environment that starts DevSpace or
`devspace-agentd`. Do not put the real key in a profile, prompt, issue, Git
commit, screenshot, or report.

PowerShell example for the current terminal only:

```powershell
$env:GEMINI_API_KEY = "YOUR_LOCAL_SECRET"
pnpm test:official-providers
```

Bash example for the current shell only:

```bash
export GEMINI_API_KEY="YOUR_LOCAL_SECRET"
pnpm test:official-providers
```

The key by itself is insufficient. TrustBridge reads the official CLI settings
file and blocks API-key mode unless `modelProvider` is exactly `gemini`. This
prevents an API key from being present while the CLI silently uses another
configured authentication path.

The DevSpace provider entry can remain free of secrets:

```jsonc
{
  "id": "antigravity",
  "enabled": true,
  "command": "agy"
}
```

### Gemini Enterprise / Google Cloud ADC

Create Application Default Credentials for the approved Google Cloud project,
then enable ADC for the official CLI:

```bash
gcloud auth application-default login --project YOUR_PROJECT
```

```jsonc
{
  "id": "antigravity",
  "enabled": true,
  "command": "agy",
  "env": {
    "AGY_ADC_AUTH": "true",
    "GOOGLE_CLOUD_PROJECT": "YOUR_PROJECT",
    "GOOGLE_CLOUD_LOCATION": "global"
  }
}
```

Do not configure both `GEMINI_API_KEY` and `AGY_ADC_AUTH=true`. DevSpace treats
that as ambiguous and blocks the provider.

## Prerequisites

1. Install and authenticate each provider through an approved official path.
2. Enable those providers in `~/.devspace/config.jsonc`.
3. For AI Studio, set `modelProvider: "gemini"` in the official Antigravity CLI settings file before injecting the key.
4. Add the project directory to `workspaces.allowedRoots`.
5. Build DevSpace from the TrustBridge branch.
6. Run the commands from the project that the providers should use.

Antigravity requires the official `agy` executable plus either correctly
configured AI Studio API-key mode or Gemini Enterprise ADC. A cached personal
Antigravity login alone is not accepted by the TrustBridge policy.

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
- missing or ambiguous approved Google automation credentials;
- missing, invalid, or non-Gemini official CLI settings for API-key mode;
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
- personal Antigravity OAuth is not accepted as an automation credential;
- AI Studio API-key mode has the required official CLI provider selection;
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
