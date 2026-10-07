# YUNXU TrustBridge MCP

**中文名：云序可信 AI 中枢**

YUNXU TrustBridge MCP extends DevSpace as a single local-first MCP control plane for officially authenticated AI providers. Project data may be sent to the official OpenAI/Codex, Anthropic/Claude, and Google model services selected by the owner. It must not be relayed through developer-hosted gateways, unofficial mirror sites, shared token pools, or unknown web services.

## Project objective

Expose one DevSpace `/mcp` endpoint while routing delegated work to locally installed official clients:

- OpenAI Codex through the official Codex CLI;
- Anthropic Claude through the official Claude Agent SDK or explicitly configured official Claude CLI;
- Google Antigravity through the official `agy` CLI only when automated use is authenticated with a Google AI Studio API key or Gemini Enterprise Application Default Credentials;
- Pi only when its provider authentication is an official provider flow;
- local workspace, Git worktree, review, and artifact operations remain controlled by DevSpace.

Personal Antigravity or Google AI Pro OAuth is intentionally not reused by DevSpace. Google states that third-party coding agents must not access Antigravity through a personal Antigravity login. The supported automated paths are Google AI Studio API-key access or Gemini Enterprise/Google Cloud ADC.

## Non-negotiable trust boundary

Default policy is `official-only`.

Allowed destinations:

- official OpenAI, Anthropic, and Google service endpoints reached by their official local clients or SDKs;
- `127.0.0.1`, `::1`, local named pipes, and local Unix sockets;
- an enterprise endpoint explicitly approved by the owner and recorded in configuration.

Allowed Google automation credentials:

- `GEMINI_API_KEY` for Google AI Studio API access; or
- `AGY_ADC_AUTH=true` with Gemini Enterprise/Google Cloud Application Default Credentials.

Only one Google automation mode may be active at a time.

Rejected by default:

- third-party AI relay or API aggregation services;
- developer-hosted web gateways and unofficial mirrors;
- browser cookie/session extraction;
- personal Antigravity/Google AI Pro OAuth reuse by DevSpace;
- raw ChatGPT, Claude, or Google refresh-token ingestion by DevSpace;
- automatic account rotation intended to evade provider quotas;
- unknown telemetry, remote log collectors, or custom provider base URLs;
- non-HTTPS remote provider endpoints or URLs containing embedded credentials;
- silent fallback from an official provider to an unofficial provider.

Provider credentials stay with the provider-owned client, operating-system keyring, local environment, or Google Cloud ADC. DevSpace stores task state and provider session identifiers, not browser cookies or provider refresh tokens.

## Architecture

```text
ChatGPT / Claude / MCP clients
              |
              v
       DevSpace /mcp
              |
   +----------+----------------+
   |          |                |
   v          v                v
 Codex      Claude    Google official automation
 official   official  agy + AI Studio key / Enterprise ADC
 client     SDK/CLI
   |          |                |
   +----------+----------------+
              |
              v
 local workspace / isolated Git worktree
```

## Delivery phases

### Phase 1 — provider integration

1. Add `antigravity` to the local-agent provider model.
2. Implement a long-lived official `agy` stream-JSON driver.
3. Require an approved Google automation authentication mode before the driver is exposed or started.
4. Add availability, configuration, profile, catalog, and presentation support.
5. Preserve cancellation, process-tree cleanup, session continuation, and bounded stderr capture.

### Phase 2 — trust policy

1. Add an `official-only` provider trust policy.
2. Reject unknown remote endpoints and unofficial command wrappers.
3. Reject personal Antigravity OAuth, ambiguous Google authentication, insecure remote HTTP, and credential-bearing URLs.
4. Report `blocked_by_trust_policy` distinctly from installation or authentication failures.
5. Redact tokens, cookies, authorization headers, and credential-shaped values from diagnostics.

### Phase 3 — stability and evidence

1. Add provider health and stability-test operations plus a model-visible verification skill.
2. Distinguish installed, authenticated, reachable, model-available, task-verified, quota-exhausted, degraded, and policy-blocked states.
3. Generate machine-readable JSON and Markdown reports.
4. Add a real-account E2E runner for Codex, Claude, and approved Google automation.
5. Verify that network egress during tests is limited to official provider services and localhost.

### Phase 4 — roundtable verification

Run one real workflow:

1. Codex produces an implementation plan.
2. Google official automation implements in an isolated worktree.
3. Claude reviews security, logic, and tests.
4. Codex performs final review from the real diff and test evidence.
5. DevSpace returns one structured result with task IDs, provider session IDs, diff evidence, and test evidence.

## Acceptance criteria

- One public MCP endpoint only.
- No provider credential is stored in the DevSpace database.
- No unknown third-party egress during official-provider tests.
- Personal Antigravity/Google AI Pro OAuth is never used by DevSpace.
- Google automation is blocked unless exactly one approved mode is configured: AI Studio API key or Gemini Enterprise ADC.
- Provider presence is not reported as readiness; a real task must pass.
- Unit/type/build checks pass in CI or an equivalent local clean-room run.
- Real-account smoke tests pass 5/5 for each enabled official provider.
- A 30-run stability test succeeds at least 29/30 per provider.
- Session continuation, cancellation, restart recovery, quota errors, and network interruption are tested explicitly.
- A failed provider never silently falls back to an unofficial relay.

## Working branch

`feature/official-provider-gateway`

All implementation and test changes remain isolated on this branch until CI and real-account E2E evidence are reviewed.