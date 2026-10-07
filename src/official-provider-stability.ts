import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { officialProviderTrustDecision } from "./official-provider-trust.js";

export const OFFICIAL_STABILITY_PROVIDERS = [
  "codex",
  "claude",
  "antigravity",
] as const;

export type OfficialStabilityProvider = typeof OFFICIAL_STABILITY_PROVIDERS[number];

export interface OfficialProviderStabilityOptions {
  providers: OfficialStabilityProvider[];
  runs: number;
  timeoutSeconds: number;
  minimumSuccessRate: number;
  workspaceRoot: string;
  outputDirectory: string;
  cliPath: string;
  continuationCheck: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface OfficialProviderRunResult {
  run: number;
  agentId?: string;
  status: "passed" | "failed";
  durationMs: number;
  markerMatched: boolean;
  responseSha256?: string;
  responseBytes?: number;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
}

export interface OfficialProviderContinuationResult {
  status: "passed" | "failed" | "not_run";
  agentId?: string;
  durationMs?: number;
  markerMatched?: boolean;
  responseSha256?: string;
  responseBytes?: number;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
}

export interface OfficialProviderStabilityResult {
  provider: OfficialStabilityProvider;
  installedAndEnabled: boolean;
  trustPolicyAllowed: boolean;
  trustPolicyReason?: string;
  runs: OfficialProviderRunResult[];
  continuation: OfficialProviderContinuationResult;
  passed: number;
  failed: number;
  successRate: number;
  meetsThreshold: boolean;
}

export interface OfficialProviderStabilityReport {
  schema: "yunxu-trustbridge/provider-stability/v1";
  project: "YUNXU TrustBridge MCP";
  startedAt: string;
  finishedAt: string;
  workspaceRoot: string;
  providers: OfficialProviderStabilityResult[];
  requirements: {
    runsPerProvider: number;
    minimumSuccessRate: number;
    timeoutSeconds: number;
    continuationCheck: boolean;
  };
  security: {
    policy: "official-only";
    credentials: "owned-by-official-client-or-os-keyring";
    responseStorage: "sha256-and-byte-count-only";
    egressObservation:
      "endpoint-overrides-validated; packet-level-egress-capture-not-performed";
  };
  passed: boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

interface AgentReceipt {
  id?: string;
  status?: string;
  error?: AgentErrorPayload;
}

interface AgentObservation {
  id?: string;
  status?: string;
  response?: string;
  error?: AgentErrorPayload;
}

interface AgentErrorPayload {
  code?: string;
  message?: string;
  retryable?: boolean;
}

const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;

export async function runOfficialProviderStability(
  options: OfficialProviderStabilityOptions,
): Promise<OfficialProviderStabilityReport> {
  validateOptions(options);
  const startedAt = new Date().toISOString();
  await access(options.cliPath);
  await mkdir(options.outputDirectory, { recursive: true });
  const env = options.env ?? process.env;
  const targetResult = await runDevspaceJson(
    options,
    ["agents", "targets", "--json"],
    env,
  );
  const targets = readTargetNames(targetResult);
  const providers: OfficialProviderStabilityResult[] = [];

  for (const provider of options.providers) {
    const trust = officialProviderTrustDecision(provider, env);
    if (!trust.allowed || !targets.has(provider)) {
      providers.push({
        provider,
        installedAndEnabled: targets.has(provider),
        trustPolicyAllowed: trust.allowed,
        ...(trust.reason ? { trustPolicyReason: trust.reason } : {}),
        runs: [],
        continuation: { status: "not_run" },
        passed: 0,
        failed: options.runs,
        successRate: 0,
        meetsThreshold: false,
      });
      continue;
    }

    const runs: OfficialProviderRunResult[] = [];
    let continuationAgentId: string | undefined;
    for (let index = 1; index <= options.runs; index += 1) {
      const marker = markerFor(provider, "run", index);
      const started = performance.now();
      const launch = await runDevspaceJson(
        options,
        [
          "agents",
          "run",
          provider,
          "--json",
          stabilityPrompt(marker),
        ],
        env,
        true,
      );
      const receipt = readReceipt(launch.value);
      if (!launch.ok || !receipt.id) {
        runs.push(failedRun(index, performance.now() - started, launch, receipt.error));
        continue;
      }
      continuationAgentId ??= receipt.id;
      const waited = await runDevspaceJson(
        options,
        [
          "agents",
          "wait",
          receipt.id,
          "--timeout",
          String(options.timeoutSeconds),
          "--json",
        ],
        env,
        true,
      );
      const observation = readObservation(waited.value, receipt.id);
      runs.push(runResultFromObservation(
        index,
        marker,
        performance.now() - started,
        waited,
        observation,
      ));
    }

    const continuation = options.continuationCheck && continuationAgentId
      ? await runContinuation(options, provider, continuationAgentId, env)
      : { status: "not_run" as const };
    const passed = runs.filter((run) => run.status === "passed").length;
    const failed = options.runs - passed;
    const successRate = options.runs > 0 ? passed / options.runs : 0;
    const continuationPass = continuation.status === "not_run"
      || continuation.status === "passed";
    providers.push({
      provider,
      installedAndEnabled: true,
      trustPolicyAllowed: true,
      runs,
      continuation,
      passed,
      failed,
      successRate,
      meetsThreshold: successRate >= options.minimumSuccessRate && continuationPass,
    });
  }

  const report: OfficialProviderStabilityReport = {
    schema: "yunxu-trustbridge/provider-stability/v1",
    project: "YUNXU TrustBridge MCP",
    startedAt,
    finishedAt: new Date().toISOString(),
    workspaceRoot: options.workspaceRoot,
    providers,
    requirements: {
      runsPerProvider: options.runs,
      minimumSuccessRate: options.minimumSuccessRate,
      timeoutSeconds: options.timeoutSeconds,
      continuationCheck: options.continuationCheck,
    },
    security: {
      policy: "official-only",
      credentials: "owned-by-official-client-or-os-keyring",
      responseStorage: "sha256-and-byte-count-only",
      egressObservation:
        "endpoint-overrides-validated; packet-level-egress-capture-not-performed",
    },
    passed: providers.length > 0 && providers.every((provider) => provider.meetsThreshold),
  };

  await writeOfficialProviderReports(report, options.outputDirectory);
  return report;
}

export async function writeOfficialProviderReports(
  report: OfficialProviderStabilityReport,
  outputDirectory: string,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(outputDirectory, "official-provider-results.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      resolve(outputDirectory, "OFFICIAL_PROVIDER_E2E_REPORT.md"),
      renderOfficialProviderReport(report),
      "utf8",
    ),
  ]);
}

export function renderOfficialProviderReport(
  report: OfficialProviderStabilityReport,
): string {
  const rows = report.providers.map((provider) => [
    provider.provider,
    provider.installedAndEnabled ? "yes" : "no",
    provider.trustPolicyAllowed ? "allowed" : "blocked",
    `${provider.passed}/${report.requirements.runsPerProvider}`,
    `${(provider.successRate * 100).toFixed(1)}%`,
    provider.continuation.status,
    provider.meetsThreshold ? "PASS" : "FAIL",
  ]);
  return [
    "# YUNXU TrustBridge MCP — Official Provider E2E Report",
    "",
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Workspace: \`${report.workspaceRoot}\``,
    `- Overall: **${report.passed ? "PASS" : "FAIL"}**`,
    `- Required success rate: ${(report.requirements.minimumSuccessRate * 100).toFixed(1)}%`,
    "",
    "| Provider | Enabled | Trust policy | Successful runs | Success rate | Continuation | Result |",
    "|---|---:|---|---:|---:|---|---|",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
    "## Security evidence",
    "",
    "- Provider credentials remained with the official client or operating-system keyring.",
    "- Provider response text was not written to the report; only SHA-256 and byte counts were retained.",
    "- Known endpoint override variables were checked against official provider domains or localhost.",
    "- This runner does not perform packet-level network capture. Packet-level egress verification remains a separate machine-level acceptance test.",
    "",
  ].join("\n");
}

export function parseOfficialProviderStabilityArgs(
  argv: string[],
  cwd = process.cwd(),
): OfficialProviderStabilityOptions {
  let providers: OfficialStabilityProvider[] = [...OFFICIAL_STABILITY_PROVIDERS];
  let runs = 5;
  let timeoutSeconds = 300;
  let minimumSuccessRate = 0.966;
  let workspaceRoot = cwd;
  let outputDirectory = resolve(cwd, "reports", "official-provider-stability");
  let cliPath = resolve(cwd, "dist", "cli.js");
  let continuationCheck = true;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const readValue = (name: string): string => {
      const value = argv[index + 1]?.trim();
      if (!value) throw new Error(`Missing value for ${name}.`);
      index += 1;
      return value;
    };
    switch (argument) {
      case "--providers":
        providers = parseProviders(readValue(argument));
        break;
      case "--runs":
        runs = parsePositiveInteger(readValue(argument), argument);
        break;
      case "--timeout":
        timeoutSeconds = parsePositiveInteger(readValue(argument), argument);
        break;
      case "--minimum-success-rate":
        minimumSuccessRate = parseRate(readValue(argument));
        break;
      case "--workspace":
        workspaceRoot = resolve(readValue(argument));
        break;
      case "--output":
        outputDirectory = resolve(readValue(argument));
        break;
      case "--cli":
        cliPath = resolve(readValue(argument));
        break;
      case "--no-continuation":
        continuationCheck = false;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  return {
    providers,
    runs,
    timeoutSeconds,
    minimumSuccessRate,
    workspaceRoot,
    outputDirectory,
    cliPath,
    continuationCheck,
  };
}

async function runContinuation(
  options: OfficialProviderStabilityOptions,
  provider: OfficialStabilityProvider,
  agentId: string,
  env: NodeJS.ProcessEnv,
): Promise<OfficialProviderContinuationResult> {
  const marker = markerFor(provider, "continue", 1);
  const started = performance.now();
  const continuation = await runDevspaceJson(
    options,
    [
      "agents",
      "continue",
      agentId,
      "--json",
      stabilityPrompt(marker),
    ],
    env,
    true,
  );
  const receipt = readReceipt(continuation.value);
  if (!continuation.ok || !receipt.id) {
    return failedContinuation(performance.now() - started, continuation, receipt.error);
  }
  const waited = await runDevspaceJson(
    options,
    [
      "agents",
      "wait",
      receipt.id,
      "--timeout",
      String(options.timeoutSeconds),
      "--json",
    ],
    env,
    true,
  );
  const observation = readObservation(waited.value, receipt.id);
  if (!waited.ok || observation.status !== "completed" || !observation.response?.includes(marker)) {
    return failedContinuation(
      performance.now() - started,
      waited,
      observation.error ?? {
        code: observation.status === "running" ? "TIMEOUT" : "MARKER_MISMATCH",
        message: observation.status === "running"
          ? "Continuation did not finish before the timeout."
          : "Continuation response did not contain the expected marker.",
        retryable: observation.status === "running",
      },
      receipt.id,
    );
  }
  return {
    status: "passed",
    agentId: receipt.id,
    durationMs: Math.round(performance.now() - started),
    markerMatched: true,
    responseSha256: digest(observation.response),
    responseBytes: Buffer.byteLength(observation.response, "utf8"),
  };
}

async function runDevspaceJson(
  options: OfficialProviderStabilityOptions,
  args: string[],
  env: NodeJS.ProcessEnv,
  tolerateFailure = false,
): Promise<{ ok: boolean; value: unknown; command: CommandResult }> {
  const command = await runCommand(
    process.execPath,
    [options.cliPath, ...args],
    options.workspaceRoot,
    env,
    (options.timeoutSeconds + 30) * 1_000,
  );
  const value = parseLastJsonLine(command.stdout);
  const ok = command.exitCode === 0 && !command.timedOut;
  if (!ok && !tolerateFailure) {
    const error = readErrorPayload(value);
    throw new Error(
      error.message
        ?? sanitizeDiagnostic(command.stderr)
        ?? `DevSpace exited with code ${command.exitCode}.`,
    );
  }
  return { ok, value, command };
}

async function runCommand(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandResult> {
  const started = performance.now();
  return await new Promise((resolvePromise) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") <= MAX_COMMAND_OUTPUT_BYTES) return next;
      const bytes = Buffer.from(next, "utf8");
      return bytes.subarray(bytes.length - MAX_COMMAND_OUTPUT_BYTES).toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        durationMs: Math.round(performance.now() - started),
        timedOut,
      });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - started),
        timedOut,
      });
    });
  });
}

function readTargetNames(value: unknown): Set<string> {
  const targets = asRecord(value)?.targets;
  if (!Array.isArray(targets)) {
    throw new Error("DevSpace returned an invalid agent target catalog.");
  }
  return new Set(targets.flatMap((entry) => {
    const name = readString(entry, "name");
    return name ? [name] : [];
  }));
}

function readReceipt(value: unknown): AgentReceipt {
  const record = asRecord(value);
  if (!record) return { error: { code: "INVALID_RECEIPT", message: "Invalid agent receipt." } };
  if (record.error) return { error: readErrorPayload(record) };
  return {
    id: readString(record, "id"),
    status: readString(record, "status"),
  };
}

function readObservation(value: unknown, agentId: string): AgentObservation {
  const entries = Array.isArray(value) ? value : [];
  const entry = entries.find((candidate) => readString(candidate, "id") === agentId)
    ?? entries[0];
  const record = asRecord(entry);
  if (!record) {
    return { error: { code: "INVALID_OBSERVATION", message: "Invalid agent wait result." } };
  }
  return {
    id: readString(record, "id"),
    status: readString(record, "status"),
    response: readString(record, "response"),
    ...(record.error ? { error: readErrorPayload({ error: record.error }) } : {}),
  };
}

function runResultFromObservation(
  run: number,
  marker: string,
  durationMs: number,
  command: { ok: boolean; value: unknown; command: CommandResult },
  observation: AgentObservation,
): OfficialProviderRunResult {
  const markerMatched = observation.response?.includes(marker) === true;
  if (command.ok && observation.status === "completed" && markerMatched) {
    const response = observation.response ?? "";
    return {
      run,
      agentId: observation.id,
      status: "passed",
      durationMs: Math.round(durationMs),
      markerMatched,
      responseSha256: digest(response),
      responseBytes: Buffer.byteLength(response, "utf8"),
    };
  }
  const error = observation.error ?? readErrorPayload(command.value);
  return {
    run,
    agentId: observation.id,
    status: "failed",
    durationMs: Math.round(durationMs),
    markerMatched,
    errorCode: error.code ?? (command.command.timedOut ? "TIMEOUT" : "STABILITY_CHECK_FAILED"),
    errorMessage: error.message
      ?? sanitizeDiagnostic(command.command.stderr)
      ?? (observation.status === "running"
        ? "Provider did not finish before the timeout."
        : "Provider response did not contain the expected marker."),
    retryable: error.retryable ?? command.command.timedOut,
  };
}

function failedRun(
  run: number,
  durationMs: number,
  command: { ok: boolean; value: unknown; command: CommandResult },
  error?: AgentErrorPayload,
): OfficialProviderRunResult {
  const resolved = error ?? readErrorPayload(command.value);
  return {
    run,
    status: "failed",
    durationMs: Math.round(durationMs),
    markerMatched: false,
    errorCode: resolved.code ?? (command.command.timedOut ? "TIMEOUT" : "AGENT_START_FAILED"),
    errorMessage: resolved.message
      ?? sanitizeDiagnostic(command.command.stderr)
      ?? "Unable to start provider stability check.",
    retryable: resolved.retryable ?? command.command.timedOut,
  };
}

function failedContinuation(
  durationMs: number,
  command: { ok: boolean; value: unknown; command: CommandResult },
  error?: AgentErrorPayload,
  agentId?: string,
): OfficialProviderContinuationResult {
  const resolved = error ?? readErrorPayload(command.value);
  return {
    status: "failed",
    agentId,
    durationMs: Math.round(durationMs),
    markerMatched: false,
    errorCode: resolved.code ?? (command.command.timedOut ? "TIMEOUT" : "CONTINUATION_FAILED"),
    errorMessage: resolved.message
      ?? sanitizeDiagnostic(command.command.stderr)
      ?? "Provider continuation check failed.",
    retryable: resolved.retryable ?? command.command.timedOut,
  };
}

function readErrorPayload(value: unknown): AgentErrorPayload {
  const error = asRecord(value)?.error;
  const record = asRecord(error);
  return {
    code: readString(record, "code"),
    message: readString(record, "message"),
    retryable: typeof record?.retryable === "boolean" ? record.retryable : undefined,
  };
}

function parseLastJsonLine(output: string): unknown {
  const lines = output.trim().split(/\r?\n/u).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]!) as unknown;
    } catch {
      // Ignore non-JSON diagnostic lines and continue backwards.
    }
  }
  return undefined;
}

function stabilityPrompt(marker: string): string {
  return [
    "This is a provider stability check.",
    "Do not modify files, run shell commands, browse the web, or call external tools.",
    "Return exactly the marker below and no other text:",
    marker,
  ].join("\n");
}

function markerFor(
  provider: OfficialStabilityProvider,
  phase: "run" | "continue",
  index: number,
): string {
  return `YUNXU_TRUSTBRIDGE_${provider.toUpperCase()}_${phase.toUpperCase()}_${index}_${randomUUID()}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeDiagnostic(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]")
    .replace(/(?:access|refresh|api|runtime)[_-]?token\s*[:=]\s*\S+/giu, "token=[REDACTED]")
    .slice(0, 2_000);
}

function parseProviders(value: string): OfficialStabilityProvider[] {
  const providers = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (providers.length === 0) throw new Error("At least one provider is required.");
  for (const provider of providers) {
    if (!(OFFICIAL_STABILITY_PROVIDERS as readonly string[]).includes(provider)) {
      throw new Error(`Unsupported official provider: ${provider}`);
    }
  }
  return [...new Set(providers)] as OfficialStabilityProvider[];
}

function parsePositiveInteger(value: string, option: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${option} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer.`);
  }
  return parsed;
}

function parseRate(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("--minimum-success-rate must be between 0 and 1.");
  }
  return parsed;
}

function validateOptions(options: OfficialProviderStabilityOptions): void {
  if (options.providers.length === 0) throw new Error("At least one provider is required.");
  if (options.runs <= 0 || !Number.isSafeInteger(options.runs)) {
    throw new Error("runs must be a positive integer.");
  }
  if (options.timeoutSeconds <= 0 || !Number.isSafeInteger(options.timeoutSeconds)) {
    throw new Error("timeoutSeconds must be a positive integer.");
  }
  if (options.minimumSuccessRate < 0 || options.minimumSuccessRate > 1) {
    throw new Error("minimumSuccessRate must be between 0 and 1.");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const result = asRecord(value)?.[key];
  return typeof result === "string" ? result : undefined;
}
