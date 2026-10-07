# YUNXU TrustBridge MCP

**中文名：云序可信 AI 中枢**

YUNXU TrustBridge MCP extends DevSpace as a single local-first MCP control plane for officially authenticated AI providers. Project data may be sent to the official OpenAI/Codex, Anthropic/Claude, and Google/Antigravity services selected by the owner. It must not be relayed through developer-hosted gateways, unofficial mirror sites, shared token pools, or unknown web services.

## Project objective

Expose one DevSpace `/mcp` endpoint while routing delegated work to locally installed official clients:

- OpenAI Codex through the official Codex CLI;
- Anthropic Claude through the official Claude Agent SDK or explicitly configured official Claude CLI;
- Google Antigravity through the official `agy` CLI;
- Pi only when its provider authentication is an official provider flow;
- local workspace, Git worktree, review, and artifact operations remain controlled by DevSpace.

## Non-negotiable trust boundary

Default policy is `official-only`.

Allowed destinations:

- official OpenAI, Anthropic, and Google service endpoints reached by their official local clients or SDKs;
- `127.0.0.1`, `::1`, local named pipes, and local Unix sockets;
- an enterprise endpoint explicitly approved by the owner and recorded in configuration.

Rejected by default:

- third-party AI relay or API aggregation services;
- developer-hosted web gateways and unofficial mirrors;
- browser cookie/session extraction;
- raw ChatGPT, Claude, or Google refresh-token ingestion by DevSpace;
- automatic account rotation intended to evade provider quotas;
- unknown telemetry, remote log collectors, or custom provider base URLs;
- silent fallback from an official provider to an unofficial provider.

Provider credentials stay with the provider-owned client or operating-system keyring. DevSpace stores task state and provider session identifiers, not browser cookies or provider refresh tokens.

## Architecture

```text
ChatGPT / Claude / MCP clients
              |
              v
       DevSpace /mcp
              |
   +----------+-----------+
   |          |           |
   v          v           v
 Codex      Claude    Antigravity
 official   official   official agy
 client     SDK/CLI    CLI
   |          |           |
   +----------+-----------+
              |
              v
 local workspace / isolated Git worktree
```

## Delivery phases

### Phase 1 — provider integration

1. Add `antigravity` to the local-agent provider model.
2. Implement a long-lived official `agy` stream-JSON driver.
3. Add availability, configuration, profile, catalog, and presentation support.
4. Preserve cancellation, process-tree cleanup, session continuation, and bounded stderr capture.

### Phase 2 — trust policy

1. Add an `official-only` provider trust policy.
2. Reject unknown remote endpoints and unofficial command wrappers.
3. Report `blocked_by_trust_policy` distinctly from installation or authentication failures.
4. Redact tokens, cookies, authorization headers, and credential-shaped values from diagnostics.

### Phase 3 — stability and evidence

1. Add MCP-visible provider health and stability-test operations.
2. Distinguish installed, authenticated, reachable, model-available, task-verified, quota-exhausted, degraded, and policy-blocked states.
3. Generate machine-readable JSON and Markdown reports.
4. Add a real-account E2E runner for Codex, Claude, and Antigravity.
5. Verify that network egress during tests is limited to official provider services and localhost.

### Phase 4 — roundtable verification

Run one real workflow:

1. Codex produces an implementation plan.
2. Antigravity implements in an isolated worktree.
3. Claude reviews security, logic, and tests.
4. Codex performs final review from the real diff and test evidence.
5. DevSpace returns one structured result with task IDs, provider session IDs, diff evidence, and test evidence.

## Acceptance criteria

- One public MCP endpoint only.
- No provider credential is stored in the DevSpace database.
- No unknown third-party egress during official-provider tests.
- Provider presence is not reported as readiness; a real task must pass.
- Unit/type/build checks pass in CI.
- Real-account smoke tests pass 5/5 for each enabled official provider.
- A 30-run stability test succeeds at least 29/30 per provider.
- Session continuation, cancellation, restart recovery, quota errors, and network interruption are tested explicitly.
- A failed provider never silently falls back to an unofficial relay.

## Working branch

`feature/official-provider-gateway`

All implementation and test changes remain isolated on this branch until CI and real-account E2E evidence are reviewed.