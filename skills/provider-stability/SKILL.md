---
name: provider-stability
description: Verify the real end-to-end availability and stability of the official Codex, Claude, and approved Google automation providers connected to DevSpace. Use when the user asks whether providers are installed, authenticated, reliable, or safely routed.
---

# Official provider stability

Use this skill only for providers the owner explicitly selected. The supported
targets are `codex`, `claude`, and `antigravity`.

Do not ask for, display, copy, or store provider passwords, browser cookies,
access tokens, refresh tokens, API keys, or keyring files. The official client,
local environment, or Google Cloud ADC owns its credentials.

For Antigravity automation, require exactly one approved mode:

- a locally injected `GEMINI_API_KEY` for Google AI Studio, with
  `~/.gemini/antigravity-cli/settings.json` containing
  `"modelProvider": "gemini"`; or
- `AGY_ADC_AUTH=true` with Gemini Enterprise/Google Cloud ADC.

The API key alone is not sufficient. Confirm the official CLI provider selection
without reading or displaying the key. Do not use or suggest personal
Antigravity or Google AI Pro OAuth through DevSpace. Do not configure both
Google automation modes simultaneously.

## Inspect before testing

Run from the workspace that should be tested:

```bash
devspace agents targets --json
devspace doctor
```

Treat a provider listed as available as an installation check only. It is not
proof that authentication, quota, model access, or a real task works.

If DevSpace reports `blocked_by_trust_policy`, do not bypass it. Identify and
remove the unsupported authentication mode, missing Gemini provider selection,
third-party endpoint, insecure URL, or gateway override. Never replace it with
an unofficial mirror or shared token service.

## Smoke test

For the standard five-run test:

```bash
pnpm test:official-providers
```

For selected providers:

```bash
pnpm build
pnpm tsx scripts/official-provider-stability.ts \
  --providers codex,claude,antigravity \
  --runs 5 \
  --timeout 300
```

The command writes local reports without model response text. Read:

```text
reports/official-provider-stability/OFFICIAL_PROVIDER_E2E_REPORT.md
reports/official-provider-stability/official-provider-results.json
```

Report which providers completed real tasks, their success rate, continuation
result, and any precise error category. Do not describe an untested provider as
working.

## Stability test

Run the 30-turn test only after the smoke test passes:

```bash
pnpm test:official-providers:stability
```

Acceptance is at least 29 successful runs out of 30 for each selected provider,
plus a successful continuation turn.

## Security interpretation

The runner verifies known endpoint overrides, approved Google automation mode,
official Gemini provider selection for API-key mode, and real task behavior. It
does not perform packet capture. State this limitation explicitly. Production
acceptance also requires a machine-level outbound connection check confirming
only official provider domains or localhost were contacted.

Unknown remote hosts, developer-hosted relays, unofficial mirrors, personal
Antigravity OAuth reuse, browser-session extraction, or automatic account
rotation are release blockers.
