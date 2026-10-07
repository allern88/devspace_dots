import { Result } from "better-result";
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

export function officialProviderTrustDecision(
  provider: LocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
): ProviderTrustDecision {
  const rules = providerRules(provider);
  const checkedVariables = [
    ...new Set([
      ...rules.flatMap((rule) => rule.variables),
      ...COMMON_RELAY_VARIABLES,
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
        `Official-only policy rejected ${variable}; ${provider} may use only its official provider endpoints or localhost.`,
      );
    }
  }

  return { allowed: true, checkedVariables };
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
      return driver.createRuntime(context);
    },
  };
}

export function isAllowedEndpoint(
  value: string,
  officialDomains: readonly string[],
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = normalizeHost(url.hostname);
  if (isLocalHost(host)) return true;
  return officialDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function isLocalEndpoint(value: string): boolean {
  try {
    return isLocalHost(normalizeHost(new URL(value).hostname));
  } catch {
    return false;
  }
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

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
}

function blocked(checkedVariables: string[], reason: string): ProviderTrustDecision {
  return { allowed: false, checkedVariables, reason };
}
