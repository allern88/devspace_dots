import assert from "node:assert/strict";
import { Result } from "better-result";
import {
  assertOfficialProviderTrust,
  isAllowedEndpoint,
  officialProviderTrustDecision,
  withOfficialProviderTrust,
} from "./official-provider-trust.js";
import type {
  LocalAgentDriver,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";

for (const url of [
  "https://api.openai.com/v1",
  "https://auth.openai.com",
  "https://api.anthropic.com",
  "https://console.anthropic.com",
  "https://generativelanguage.googleapis.com/v1",
  "https://accounts.google.com",
  "https://antigravity.google",
  "http://127.0.0.1:8317/v1",
  "http://localhost:4000",
]) {
  const domains = url.includes("openai")
    ? ["openai.com"]
    : url.includes("anthropic")
      ? ["anthropic.com"]
      : url.includes("google") || url.includes("antigravity")
        ? ["google.com", "googleapis.com", "antigravity.google"]
        : [];
  assert.equal(isAllowedEndpoint(url, domains), true, url);
}
assert.equal(
  isAllowedEndpoint("https://openai.com.attacker.example/v1", ["openai.com"]),
  false,
);
assert.equal(
  isAllowedEndpoint("https://developer-relay.example/v1", ["openai.com"]),
  false,
);

assert.equal(officialProviderTrustDecision("codex", {
  OPENAI_BASE_URL: "https://api.openai.com/v1",
}).allowed, true);
assert.equal(officialProviderTrustDecision("claude", {
  ANTHROPIC_BASE_URL: "https://api.anthropic.com",
}).allowed, true);
assert.equal(officialProviderTrustDecision("antigravity", {
  GEMINI_API_BASE_URL: "https://generativelanguage.googleapis.com/v1",
}).allowed, true);
assert.equal(officialProviderTrustDecision("pi", {
  OPENAI_BASE_URL: "https://api.openai.com/v1",
  ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  GEMINI_API_BASE_URL: "https://generativelanguage.googleapis.com/v1",
}).allowed, true);

for (const [provider, env, variable] of [
  ["codex", { OPENAI_BASE_URL: "https://developer-relay.example/v1" }, "OPENAI_BASE_URL"],
  ["claude", { ANTHROPIC_BASE_URL: "https://developer-relay.example/v1" }, "ANTHROPIC_BASE_URL"],
  ["antigravity", { GEMINI_API_BASE_URL: "https://developer-relay.example/v1" }, "GEMINI_API_BASE_URL"],
  ["pi", { AI_GATEWAY_URL: "https://developer-relay.example/v1" }, "AI_GATEWAY_URL"],
] as const) {
  const decision = officialProviderTrustDecision(provider, env);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", new RegExp(variable));
  assert.throws(() => assertOfficialProviderTrust(provider, env), /Official-only policy rejected/);
}
assert.equal(officialProviderTrustDecision("codex", {
  AI_GATEWAY_URL: "http://127.0.0.1:4000",
}).allowed, true);

const runtime: LocalAgentRuntime = {
  provider: "codex",
  async run() {
    return Result.ok({
      provider: "codex",
      providerSessionId: "session",
      finalResponse: "ok",
      items: [],
    });
  },
  async releaseSession() {},
  async close() {},
  isAlive: () => true,
};
const delegate: LocalAgentDriver = {
  provider: "codex",
  runtimeKey: () => "delegate-key",
  async createRuntime() { return Result.ok(runtime); },
};
const context: LocalAgentRuntimeContext = {
  agentId: "agt_test",
  provider: "codex",
  workspaceRoot: process.cwd(),
};
const allowed = withOfficialProviderTrust(delegate, {
  OPENAI_BASE_URL: "https://api.openai.com/v1",
});
assert.equal(allowed.runtimeKey(context), "official-only:delegate-key");
assert.equal((await allowed.createRuntime(context)).isOk(), true);

const blocked = withOfficialProviderTrust(delegate, {
  OPENAI_BASE_URL: "https://developer-relay.example/v1",
});
const blockedRuntime = await blocked.createRuntime(context);
assert.equal(blockedRuntime.isErr(), true);
if (blockedRuntime.isErr()) {
  assert.equal(blockedRuntime.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(blockedRuntime.error.operation, "trust_policy");
  assert.equal(blockedRuntime.error.retryable, false);
}
