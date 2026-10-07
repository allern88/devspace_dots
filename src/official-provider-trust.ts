import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Result } from "better-result";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { AgentProviderUnavailableError } from "./local-agent-errors.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
import type {
  LocalAgentDriver,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";

export interface ProviderTrustDecision {
  allowed: boolean;
  checkedVariables: string[];
  reason?: string;
}

export type GoogleAutomationAuthMode = "ai-studio-api-key" | "gemini-enterprise-adc";

export interface GoogleAutomationConfigurationDecision {
  mode?: GoogleAutomationAuthMode;
  allowed: boolean;
  reason?: string;
}

interface EndpointRule {
  variables: readonly string[];
  officialDomains: readonly string[];
}

const OPENAI_RULE: EndpointRule = {
  variables: [
    "OPENAI_BASE_URL",
    "OPENAI_API_BASE",
    "OPENAI_API_BASE_URL",
    "CODEX_BASE_URL",
    "CODEX_API_BASE_URL",
  ],
  officialDomains: ["openai.com", "chatgpt.com"],
};

const ANTHROPIC_RULE: EndpointRule = {
  variables: [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_URL",
    "CLAUDE_BASE_URL",
    "CLAUDE_API_BASE_URL",
  ],
  officialDomains: ["anthropic.com", "claude.ai"],
};

const GOOGLE_RULE: EndpointRule = {
  variables: [
    "AGY_BASE_URL",
    "AGY_API_BASE_URL",
    "ANTIGRAVITY_BASE_URL",
    "ANTIGRAVITY_API_BASE_URL",
    "GEMINI_BASE_URL",
    "GEMINI_API_BASE",
    "GEMINI_API_BASE_URL",
    "GOOGLE_API_BASE_URL",
  ],
  officialDomains: [
    "google.com",
    "googleapis.com",
    "antigravity.google",
    "gstatic.com",
  ],
};

const COMMON_RELAY_VARIABLES = [
  "AI_GATEWAY_URL",
  "LLM_GATEWAY_URL",
  "MODEL_GATEWAY_URL",
  "OPENAI_COMPATIBLE_BASE_URL",
] as const;

const GOOGLE_AUTOMATION_AUTH_VARIABLES = [
  "GEMINI_API_KEY",
  "AGY_ADC_AUTH",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
] as const;

export function officialProviderTrustDecision(
  provider: LocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
): ProviderTrustDecision {
  const rules = providerRules(provider);
  const checkedVariables = [
    ...new Set([
      ...rules.flatMap((rule) => rule.variables),
      ...COMMON_RELAY_VARIABLES,
      ...(provider === "antigravity" ? GOOGLE_AUTOMATION_AUTH_VARIABLES : []),
    ]),
  ];

  for (const variable of COMMON_RELAY_VARIABLES) {
    const value = env[variable]?.trim();
    if (!value) continue;
    if (isLocalEndpoint(value)) continue;
    return blocked(
      checkedVariables,
      `Official-only policy rejected ${variable}; shared or third-party AI gateways are not allowed.`,
    );
  }

  for (const rule of rules) {
    for (const variable of rule.variables) {
      const value = env[variable]?.trim();
      if (!value) continue;
      if (isAllowedEndpoint(value, rule.officialDomains)) continue;
      return blocked(
        checkedVariables,
        `Official-only policy rejected ${variable}; ${provider} may use only credential-free HTTPS official provider endpoints or localhost.`,
      );
    }
  }

  if (provider === "antigravity") {
    const configuration = googleAutomationConfigurationDecision(env);
    if (!configuration.allowed) {
      return blocked(
        checkedVariables,
        configuration.reason ?? "Google automation configuration is not approved.",
      );
    }
  }

  return { allowed: true, checkedVariables };
}

export function googleAutomationAuthMode(
  env: NodeJS.ProcessEnv = process.env,
): GoogleAutomationAuthMode | "ambiguous" | undefined {
  const hasApiKey = Boolean(env.GEMINI_API_KEY?.trim());
  const hasEnterpriseAdc = env.AGY_ADC_AUTH?.trim().toLowerCase() === "true";
  if (hasApiKey && hasEnterpriseAdc) return "ambiguous";
  if (hasEnterpriseAdc) return "gemini-enterprise-adc";
  if (hasApiKey) return "ai-studio-api-key";
  return undefined;
}

export function googleAutomationConfigurationDecision(
  env: NodeJS.ProcessEnv = process.env,
): GoogleAutomationConfigurationDecision {
  const auth = googleAutomationAuthMode(env);
  if (auth === "ambiguous") {
    return {
      allowed: false,
      reason:
        "Official-only policy rejected ambiguous Google automation credentials. Configure either GEMINI_API_KEY for Google AI Studio or AGY_ADC_AUTH=true for Gemini Enterprise ADC, not both.",
    };
  }
  if (!auth) {
    return {
      allowed: false,
      reason:
        "Automated Antigravity access requires GEMINI_API_KEY or AGY_ADC_AUTH=true. Personal Antigravity/Google AI Pro OAuth must remain inside Google's own interactive products and is not used by DevSpace.",
    };
  }
  if (auth === "gemini-enterprise-adc") {
    return { allowed: true, mode: auth };
  }

  const settings = readAntigravitySettings(env);
  if (!settings.ok) {
    return {
      allowed: false,
      mode: auth,
      reason: settings.reason,
    };
  }
  if (settings.value.modelProvider !== "gemini") {
    return {
      allowed: false,
      mode: auth,
      reason:
        "GEMINI_API_KEY requires ~/.gemini/antigravity-cli/settings.json to set modelProvider to 'gemini'; otherwise the official CLI may use a different authentication path.",
    };
  }
  return { allowed: true, mode: auth };
}

export function antigravitySettingsPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = process.platform === "win32"
    ? env.USERPROFILE?.trim() || env.HOME?.trim() || homedir()
    : env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  return join(home, ".gemini", "antigravity-cli", "settings.json");
}

export function assertOfficialProviderTrust(
  provider: LocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const decision = officialProviderTrustDecision(provider, env);
  if (decision.allowed) return;
  throw new AgentProviderUnavailableError({
    code: "PROVIDER_UNAVAILABLE",
    provider,
    operation: "trust_policy",
    retryable: false,
    message: decision.reason ?? "Provider blocked by official-only policy.",
  });
}

export function withOfficialProviderTrust(
  driver: LocalAgentDriver,
  env: NodeJS.ProcessEnv,
): LocalAgentDriver {
  return {
    provider: driver.provider,
    idleTimeoutMs: driver.idleTimeoutMs,
    runtimeKey(context: LocalAgentRuntimeContext): string {
      return `official-only:${driver.runtimeKey(context)}`;
    },
    async createRuntime(context: LocalAgentRuntimeContext) {
      const decision = officialProviderTrustDecision(driver.provider, env);
      if (!decision.allowed) {
        return Result.err(new AgentProviderUnavailableError({
          code: "PROVIDER_UNAVAILABLE",
          provider: driver.provider,
          agentId: context.agentId,
          operation: "trust_policy",
          retryable: false,
          message: decision.reason ?? "Provider blocked by official-only policy.",
        }));
      }
      const result = await driver.createRuntime(context);
      if (
        driver.provider === "antigravity"
        && result.isErr()
        && isAuthenticationFailure(result.error.message)
      ) {
        return Result.err(new AgentProviderUnavailableError({
          code: "PROVIDER_UNAVAILABLE",
          provider: "antigravity",
          agentId: context.agentId,
          operation: result.error.operation,
          retryable: false,
          cause: result.error,
          message:
            "Google automation authentication failed. Verify GEMINI_API_KEY with modelProvider='gemini', or Gemini Enterprise ADC with AGY_ADC_AUTH=true. Personal Antigravity/Google AI Pro OAuth is not supported through DevSpace.",
        }));
      }
      return result;
    },
  };
}

export function isAllowedEndpoint(
  value: string,
  officialDomains: readonly string[],
): boolean {
  const url = parseEndpoint(value);
  if (!url || hasEmbeddedCredentials(url)) return false;
  const host = normalizeHost(url.hostname);
  if (isLocalHost(host)) return isHttpProtocol(url.protocol);
  if (url.protocol !== "https:") return false;
  return officialDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function isLocalEndpoint(value: string): boolean {
  const url = parseEndpoint(value);
  if (!url || hasEmbeddedCredentials(url) || !isHttpProtocol(url.protocol)) return false;
  return isLocalHost(normalizeHost(url.hostname));
}

function providerRules(provider: LocalAgentProvider): EndpointRule[] {
  switch (provider) {
    case "codex":
      return [OPENAI_RULE];
    case "claude":
      return [ANTHROPIC_RULE];
    case "antigravity":
      return [GOOGLE_RULE];
    case "pi":
    case "opencode":
      return [OPENAI_RULE, ANTHROPIC_RULE, GOOGLE_RULE];
    case "cursor":
    case "copilot":
    case "grok":
      return [];
  }
}

function readAntigravitySettings(
  env: NodeJS.ProcessEnv,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string } {
  let source: string;
  try {
    source = readFileSync(antigravitySettingsPath(env), "utf8").replace(/^\uFEFF/u, "");
  } catch {
    return {
      ok: false,
      reason:
        "GEMINI_API_KEY requires ~/.gemini/antigravity-cli/settings.json with modelProvider set to 'gemini'; the settings file could not be read.",
    };
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || !isRecord(parsed)) {
    return {
      ok: false,
      reason:
        "GEMINI_API_KEY requires a valid ~/.gemini/antigravity-cli/settings.json with modelProvider set to 'gemini'.",
    };
  }
  return { ok: true, value: parsed };
}

function parseEndpoint(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function hasEmbeddedCredentials(url: URL): boolean {
  return url.username.length > 0 || url.password.length > 0;
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
}

function isAuthenticationFailure(message: string): boolean {
  return /authentication|required.*auth|sign[ -]?in|invalid.*credential|unauthori[sz]ed|forbidden|\b401\b|\b403\b/iu
    .test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function blocked(checkedVariables: string[], reason: string): ProviderTrustDecision {
  return { allowed: false, checkedVariables, reason };
}
