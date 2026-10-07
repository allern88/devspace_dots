import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { AgentProviderUnavailableError } from "./local-agent-errors.js";
import {
  antigravitySettingsPath,
  assertOfficialProviderTrust,
  googleAutomationAuthMode,
  googleAutomationConfigurationDecision,
  isAllowedEndpoint,
  officialProviderTrustDecision,
  withOfficialProviderTrust,
} from "./official-provider-trust.js";
import type {
  LocalAgentDriver,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";

function createGoogleHome(settingsSource?: string): string {
  const home = mkdtempSync(join(tmpdir(), "devspace-google-auth-"));
  if (settingsSource !== undefined) {
    const directory = join(home, ".gemini", "antigravity-cli");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "settings.json"), settingsSource, "utf8");
  }
  return home;
}

const geminiHome = createGoogleHome(`{
  // The official CLI requires this provider selection for API-key mode.
  "modelProvider": "gemini",
}`);
const missingSettingsHome = createGoogleHome();
const wrongProviderHome = createGoogleHome('{"modelProvider":"antigravity"}');
const invalidSettingsHome = createGoogleHome('{"modelProvider":');

try {
  for (const url of [
    "https://api.openai.com/v1",
    "https://auth.openai.com",
    "https://api.anthropic.com",
    "https://console.anthropic.com",
    "https://generativelanguage.googleapis.com/v1",
    "https://accounts.google.com",
    "https://antigravity.google",
    "http://127.0.0.1:8317/v1",
    "https://127.0.0.1:8317/v1",
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
  for (const url of [
    "https://openai.com.attacker.example/v1",
    "https://developer-relay.example/v1",
    "http://api.openai.com/v1",
    "ftp://api.openai.com/v1",
    "https://user:password@api.openai.com/v1",
    "http://user:password@127.0.0.1:8317/v1",
    "not-a-url",
  ]) {
    assert.equal(isAllowedEndpoint(url, ["openai.com"]), false, url);
  }

  assert.equal(officialProviderTrustDecision("codex", {
    OPENAI_BASE_URL: "https://api.openai.com/v1",
  }).allowed, true);
  assert.equal(officialProviderTrustDecision("claude", {
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  }).allowed, true);
  assert.equal(googleAutomationAuthMode({ GEMINI_API_KEY: "test-key" }), "ai-studio-api-key");
  assert.equal(googleAutomationAuthMode({ AGY_ADC_AUTH: "TRUE" }), "gemini-enterprise-adc");
  assert.equal(googleAutomationAuthMode({
    GEMINI_API_KEY: "test-key",
    AGY_ADC_AUTH: "true",
  }), "ambiguous");
  assert.equal(googleAutomationAuthMode({}), undefined);
  assert.equal(
    antigravitySettingsPath({ HOME: geminiHome }),
    join(geminiHome, ".gemini", "antigravity-cli", "settings.json"),
  );

  const apiKeyEnv = {
    HOME: geminiHome,
    USERPROFILE: geminiHome,
    GEMINI_API_BASE_URL: "https://generativelanguage.googleapis.com/v1",
    GEMINI_API_KEY: "test-key",
  };
  assert.deepEqual(googleAutomationConfigurationDecision(apiKeyEnv), {
    allowed: true,
    mode: "ai-studio-api-key",
  });
  assert.equal(officialProviderTrustDecision("antigravity", apiKeyEnv).allowed, true);
  assert.equal(officialProviderTrustDecision("antigravity", {
    AGY_ADC_AUTH: "true",
    GOOGLE_CLOUD_PROJECT: "test-project",
    GOOGLE_CLOUD_LOCATION: "us",
  }).allowed, true);
  assert.equal(officialProviderTrustDecision("pi", {
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    GEMINI_API_BASE_URL: "https://generativelanguage.googleapis.com/v1",
  }).allowed, true);

  const missingGoogleAutomationAuth = officialProviderTrustDecision("antigravity", {
    GEMINI_API_BASE_URL: "https://generativelanguage.googleapis.com/v1",
  });
  assert.equal(missingGoogleAutomationAuth.allowed, false);
  assert.match(missingGoogleAutomationAuth.reason ?? "", /requires GEMINI_API_KEY or AGY_ADC_AUTH=true/);
  assert.match(missingGoogleAutomationAuth.reason ?? "", /Personal Antigravity\/Google AI Pro OAuth/);

  const missingSettings = googleAutomationConfigurationDecision({
    HOME: missingSettingsHome,
    USERPROFILE: missingSettingsHome,
    GEMINI_API_KEY: "test-key",
  });
  assert.equal(missingSettings.allowed, false);
  assert.match(missingSettings.reason ?? "", /settings\.json/);
  assert.doesNotMatch(missingSettings.reason ?? "", new RegExp(missingSettingsHome.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));

  const wrongProvider = googleAutomationConfigurationDecision({
    HOME: wrongProviderHome,
    USERPROFILE: wrongProviderHome,
    GEMINI_API_KEY: "test-key",
  });
  assert.equal(wrongProvider.allowed, false);
  assert.match(wrongProvider.reason ?? "", /modelProvider.*gemini/);

  const invalidSettings = googleAutomationConfigurationDecision({
    HOME: invalidSettingsHome,
    USERPROFILE: invalidSettingsHome,
    GEMINI_API_KEY: "test-key",
  });
  assert.equal(invalidSettings.allowed, false);
  assert.match(invalidSettings.reason ?? "", /valid.*settings\.json/);

  const ambiguousGoogleAutomationAuth = officialProviderTrustDecision("antigravity", {
    HOME: geminiHome,
    GEMINI_API_KEY: "must-not-appear",
    AGY_ADC_AUTH: "true",
  });
  assert.equal(ambiguousGoogleAutomationAuth.allowed, false);
  assert.match(ambiguousGoogleAutomationAuth.reason ?? "", /either GEMINI_API_KEY.*or AGY_ADC_AUTH=true/);
  assert.doesNotMatch(ambiguousGoogleAutomationAuth.reason ?? "", /must-not-appear/);

  for (const [provider, env, variable] of [
    ["codex", { OPENAI_BASE_URL: "https://developer-relay.example/v1" }, "OPENAI_BASE_URL"],
    ["codex", { OPENAI_BASE_URL: "http://api.openai.com/v1" }, "OPENAI_BASE_URL"],
    ["codex", { OPENAI_BASE_URL: "https://user:password@api.openai.com/v1" }, "OPENAI_BASE_URL"],
    ["claude", { ANTHROPIC_BASE_URL: "https://developer-relay.example/v1" }, "ANTHROPIC_BASE_URL"],
    [
      "antigravity",
      {
        HOME: geminiHome,
        GEMINI_API_BASE_URL: "https://developer-relay.example/v1",
        GEMINI_API_KEY: "test-key",
      },
      "GEMINI_API_BASE_URL",
    ],
    [
      "antigravity",
      {
        HOME: geminiHome,
        GOOGLE_GEMINI_BASE_URL: "https://developer-relay.example/v1",
        GEMINI_API_KEY: "test-key",
      },
      "GOOGLE_GEMINI_BASE_URL",
    ],
    ["pi", { AI_GATEWAY_URL: "https://developer-relay.example/v1" }, "AI_GATEWAY_URL"],
    ["pi", { AI_GATEWAY_URL: "http://user:password@127.0.0.1:4000" }, "AI_GATEWAY_URL"],
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

  const antigravityDelegate: LocalAgentDriver = {
    provider: "antigravity",
    runtimeKey: () => "antigravity-key",
    async createRuntime() {
      return Result.err(new AgentProviderUnavailableError({
        code: "PROVIDER_UNAVAILABLE",
        provider: "antigravity",
        operation: "create_runtime",
        retryable: false,
        message: "Authentication required. Sign in to continue.",
      }));
    },
  };
  const transformedAuthFailure = await withOfficialProviderTrust(
    antigravityDelegate,
    apiKeyEnv,
  ).createRuntime({
    agentId: "agt_google",
    provider: "antigravity",
    workspaceRoot: process.cwd(),
  });
  assert.equal(transformedAuthFailure.isErr(), true);
  if (transformedAuthFailure.isErr()) {
    assert.match(transformedAuthFailure.error.message, /GEMINI_API_KEY with modelProvider='gemini'/);
    assert.match(transformedAuthFailure.error.message, /Personal Antigravity\/Google AI Pro OAuth is not supported/);
    assert.doesNotMatch(transformedAuthFailure.error.message, /Sign in to continue/);
  }
} finally {
  for (const directory of [
    geminiHome,
    missingSettingsHome,
    wrongProviderHome,
    invalidSettingsHome,
  ]) {
    rmSync(directory, { recursive: true, force: true });
  }
}
