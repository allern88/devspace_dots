import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  AgentProviderCancelledError,
  AgentProviderExecutionError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
} from "./local-agent-errors.js";
import { resolveExecutableCommand } from "./local-agent-command.js";
import { terminateProcessTree } from "./process-platform.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
  LocalAgentWriteMode,
} from "./local-agent-runtime.js";

const ANTIGRAVITY_INIT_TIMEOUT_MS = 15_000;
const ANTIGRAVITY_EXIT_TIMEOUT_MS = 1_000;
const MAX_ANTIGRAVITY_EVENTS = 10_000;
const MAX_ANTIGRAVITY_STDERR_BYTES = 32 * 1024;
const DEFAULT_PRINT_TIMEOUT = "15m";

const ANTIGRAVITY_ENDPOINT_ENV_VARS = [
  "AGY_BASE_URL",
  "AGY_API_BASE_URL",
  "ANTIGRAVITY_BASE_URL",
  "ANTIGRAVITY_API_BASE_URL",
  "GEMINI_BASE_URL",
  "GEMINI_API_BASE",
  "GEMINI_API_BASE_URL",
] as const;

export interface ResolvedAntigravityCommand {
  executable: string;
}

export type AntigravityCommandResolver = (
  env: NodeJS.ProcessEnv,
) => ResolvedAntigravityCommand | undefined;

export interface AntigravityStreamRuntimeOptions {
  command: string;
  env: NodeJS.ProcessEnv;
  workspaceRoot: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  effort?: string;
  printTimeout?: string;
}

interface AntigravityTurn {
  items: unknown[];
  resolve: (result: LocalAgentRunResult) => void;
  reject: (error: Error) => void;
}

export class AntigravityStreamRuntime implements LocalAgentRuntime {
  readonly provider = "antigravity" as const;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly ready: Promise<string>;
  private resolveReady!: (conversationId: string) => void;
  private rejectReady!: (error: Error) => void;
  private conversationId?: string;
  private activeTurn?: AntigravityTurn;
  private stderr = "";
  private alive = true;
  private closed = false;
  private readySettled = false;

  constructor(private readonly options: AntigravityStreamRuntimeOptions) {
    this.ready = new Promise<string>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.child = spawn(options.command, antigravityArguments(options), {
      cwd: options.workspaceRoot,
      env: officialAntigravityEnvironment(options.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: usesWindowsCommandShell(options.command),
    });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity })
      .on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = appendTail(
        this.stderr,
        chunk.toString("utf8"),
        MAX_ANTIGRAVITY_STDERR_BYTES,
      );
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", (code, signal) => {
      if (this.closed) return;
      this.fail(new Error(
        `Antigravity CLI exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}.`,
      ));
    });
  }

  async initialize(timeoutMs = ANTIGRAVITY_INIT_TIMEOUT_MS): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Antigravity CLI did not emit an init event before the timeout."));
          }, timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks) {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "run",
      run: async (): Promise<LocalAgentRunResult> => {
        if (!this.isAlive()) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            operation: "run",
            retryable: true,
            message: "Antigravity CLI runtime is not running.",
          });
        }
        if (this.activeTurn) {
          throw new TypeError("Antigravity CLI already has an active turn.");
        }
        assertAntigravityRunCompatible(this.options, input);
        const conversationId = await this.initialize();
        if (input.providerSessionId && input.providerSessionId !== conversationId) {
          throw incompatible("conversation", conversationId, input.providerSessionId);
        }
        await callbacks?.onSessionId?.(conversationId);

        return await new Promise<LocalAgentRunResult>((resolve, reject) => {
          this.activeTurn = { items: [], resolve, reject };
          try {
            this.child.stdin.write(`${JSON.stringify({
              event: "user",
              message: { content: input.prompt },
            })}\n`);
          } catch (error) {
            this.activeTurn = undefined;
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    });
  }

  async releaseSession(_providerSessionId: string): Promise<void> {
    // A stream-json process owns one conversation. The runtime pool closes it.
  }

  isAlive(): boolean {
    return this.alive
      && !this.closed
      && !this.child.killed
      && this.child.exitCode === null;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    const closed = new Error("Antigravity CLI runtime closed.");
    this.rejectPending(closed);
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (this.child.exitCode === null) {
      if (!await waitForProcessExit(this.child, ANTIGRAVITY_EXIT_TIMEOUT_MS)) {
        terminateProcessTree(this.child, "SIGTERM", process.platform !== "win32");
        if (!await waitForProcessExit(this.child, ANTIGRAVITY_EXIT_TIMEOUT_MS)) {
          terminateProcessTree(this.child, "SIGKILL", process.platform !== "win32");
        }
      }
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.fail(new Error("Antigravity CLI emitted malformed stream JSON."));
      return;
    }

    const eventName = readString(event, "event");
    if (eventName === "init") {
      const conversationId = readString(event, "conversation_id")
        ?? readString(asRecord(event.init), "conversation_id");
      if (!conversationId) {
        this.fail(new Error("Antigravity CLI init event did not contain a conversation id."));
        return;
      }
      this.conversationId = conversationId;
      if (!this.readySettled) {
        this.readySettled = true;
        this.resolveReady(conversationId);
      }
      return;
    }

    const turn = this.activeTurn;
    if (!turn) return;
    appendBounded(turn.items, event, MAX_ANTIGRAVITY_EVENTS);
    if (eventName !== "result") return;

    this.activeTurn = undefined;
    const envelope = asRecord(event.result);
    const conversationId = readString(envelope, "conversation_id")
      ?? readString(event, "conversation_id")
      ?? this.conversationId;
    if (conversationId && !this.conversationId) this.conversationId = conversationId;
    const status = readString(envelope, "status")?.toUpperCase() ?? "INVALID";
    const response = readString(envelope, "response") ?? "";
    const error = readString(envelope, "error") ?? "";

    if (status === "SUCCESS") {
      if (!response.trim()) {
        turn.reject(new AgentProviderProtocolError({
          code: "PROVIDER_PROTOCOL_ERROR",
          provider: this.provider,
          operation: "run",
          retryable: false,
          cause: event,
          message: "Antigravity CLI returned SUCCESS without a final response.",
        }));
        return;
      }
      turn.resolve({
        provider: this.provider,
        providerSessionId: conversationId ?? null,
        finalResponse: response.trim(),
        items: turn.items.slice(),
      });
      return;
    }

    if (status === "CANCELED" || status === "INTERRUPTED") {
      turn.reject(new AgentProviderCancelledError({
        code: "PROVIDER_CANCELLED",
        provider: this.provider,
        operation: "run",
        retryable: false,
        cause: event,
        message: error || `Antigravity CLI turn ended with ${status}.`,
      }));
      return;
    }

    turn.reject(new AgentProviderExecutionError({
      code: "PROVIDER_EXECUTION_ERROR",
      provider: this.provider,
      operation: "run",
      retryable: isRetryableAntigravityError(error),
      cause: event,
      message: error || `Antigravity CLI turn ended with ${status}.`,
    }));
  }

  private fail(error: Error): void {
    if (!this.alive && this.readySettled) return;
    this.alive = false;
    const detailed = new Error([
      error.message,
      this.stderr.trim() ? `stderr:\n${this.stderr.trim()}` : undefined,
    ].filter(Boolean).join("\n"));
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(detailed);
    }
    this.rejectPending(detailed);
  }

  private rejectPending(error: Error): void {
    const turn = this.activeTurn;
    this.activeTurn = undefined;
    turn?.reject(error);
  }
}

export class AntigravityLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "antigravity" as const;
  readonly idleTimeoutMs = 5 * 60_000;
  private commandResolved = false;
  private resolvedCommand?: ResolvedAntigravityCommand;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly commandResolver: AntigravityCommandResolver = resolveAntigravityCommand,
  ) {}

  runtimeKey(context: LocalAgentRuntimeContext): string {
    const command = this.resolveCommand()?.executable
      ?? this.env.ANTIGRAVITY_COMMAND
      ?? "agy";
    return [
      "antigravity",
      context.agentId,
      command,
      context.workspaceRoot,
      context.providerSessionId ?? "new",
      context.writeMode ?? "allowed",
      context.model ?? "default",
      context.effort ?? "default",
    ].join(":");
  }

  async createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({
      provider: this.provider,
      agentId: context.agentId,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
        const command = this.resolveCommand();
        if (!command) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            agentId: context.agentId,
            operation: "create_runtime",
            retryable: false,
            message: "Official Antigravity CLI executable 'agy' was not found.",
          });
        }
        assertOfficialAntigravityCommand(command.executable);
        assertOfficialAntigravityEndpoints(this.env);
        if (context.writeMode === "read_only") {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            agentId: context.agentId,
            operation: "create_runtime",
            retryable: false,
            message:
              "Antigravity headless mode cannot currently enforce DevSpace read_only semantics. Use allowed mode in an isolated worktree, or select another provider for read-only review.",
          });
        }
        const runtime = new AntigravityStreamRuntime({
          command: command.executable,
          env: this.env,
          workspaceRoot: context.workspaceRoot,
          providerSessionId: context.providerSessionId,
          writeMode: context.writeMode,
          model: context.model,
          effort: context.effort,
        });
        try {
          await runtime.initialize();
          return runtime;
        } catch (cause) {
          await runtime.close();
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            agentId: context.agentId,
            operation: "create_runtime",
            retryable: isRetryableAntigravityError(errorMessage(cause)),
            cause,
            message: antigravityStartupMessage(cause),
          });
        }
      },
    });
  }

  private resolveCommand(): ResolvedAntigravityCommand | undefined {
    if (!this.commandResolved) {
      this.resolvedCommand = this.commandResolver(this.env);
      this.commandResolved = true;
    }
    return this.resolvedCommand;
  }
}

export function resolveAntigravityCommand(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAntigravityCommand | undefined {
  const executable = resolveExecutableCommand(env.ANTIGRAVITY_COMMAND ?? "agy", env);
  return executable ? { executable } : undefined;
}

export function officialAntigravityEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...env };
}

export function antigravityArguments(
  options: Pick<
    AntigravityStreamRuntimeOptions,
    "providerSessionId" | "writeMode" | "model" | "effort" | "printTimeout"
  >,
): string[] {
  const args = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--print-timeout",
    options.printTimeout ?? DEFAULT_PRINT_TIMEOUT,
  ];
  if (options.providerSessionId) args.push("--conversation", options.providerSessionId);
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.writeMode === "full_access") args.push("--dangerously-skip-permissions");
  else args.push("--sandbox");
  return args;
}

export function assertOfficialAntigravityCommand(command: string): void {
  const name = (command.split(/[\\/]/u).at(-1) ?? command)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com)$/u, "");
  if (name === "agy") return;
  throw new AgentProviderUnavailableError({
    code: "PROVIDER_UNAVAILABLE",
    provider: "antigravity",
    operation: "trust_policy",
    retryable: false,
    message:
      `Official-only policy rejected ANTIGRAVITY_COMMAND '${command}'. The executable basename must be agy.`,
  });
}

export function assertOfficialAntigravityEndpoints(env: NodeJS.ProcessEnv): void {
  for (const variable of ANTIGRAVITY_ENDPOINT_ENV_VARS) {
    const value = env[variable]?.trim();
    if (!value) continue;
    if (isOfficialGoogleEndpoint(value)) continue;
    throw new AgentProviderUnavailableError({
      code: "PROVIDER_UNAVAILABLE",
      provider: "antigravity",
      operation: "trust_policy",
      retryable: false,
      message:
        `Official-only policy rejected ${variable}. Antigravity may connect only to Google-owned endpoints or localhost.`,
    });
  }
}

export function isOfficialGoogleEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return true;
  return host === "google.com"
    || host.endsWith(".google.com")
    || host === "googleapis.com"
    || host.endsWith(".googleapis.com")
    || host === "antigravity.google"
    || host.endsWith(".antigravity.google");
}

function assertAntigravityRunCompatible(
  options: AntigravityStreamRuntimeOptions,
  input: LocalAgentRunInput,
): void {
  if (input.writeMode === "read_only") {
    throw new AgentProviderUnavailableError({
      code: "PROVIDER_UNAVAILABLE",
      provider: "antigravity",
      operation: "run",
      retryable: false,
      message: "Antigravity does not currently provide an enforceable read-only headless mode.",
    });
  }
  if (input.providerSessionId && options.providerSessionId
    && input.providerSessionId !== options.providerSessionId) {
    throw incompatible("conversation", options.providerSessionId, input.providerSessionId);
  }
  if (input.model && options.model && input.model !== options.model) {
    throw incompatible("model", options.model, input.model);
  }
  if (input.effort && options.effort && input.effort !== options.effort) {
    throw incompatible("effort", options.effort, input.effort);
  }
  if (input.writeMode && options.writeMode && input.writeMode !== options.writeMode) {
    throw incompatible("write mode", options.writeMode, input.writeMode);
  }
}

function incompatible(kind: string, active: string, requested: string): AgentProviderProtocolError {
  return new AgentProviderProtocolError({
    code: "PROVIDER_PROTOCOL_ERROR",
    provider: "antigravity",
    operation: "configure_session",
    retryable: false,
    message:
      `Antigravity stream session uses ${kind} '${active}' and cannot switch to '${requested}' without creating a new runtime.`,
  });
}

function antigravityStartupMessage(cause: unknown): string {
  const message = errorMessage(cause);
  if (/authentication required|sign[ -]?in|required.*auth/iu.test(message)) {
    return "Antigravity authentication is required. Run 'agy' interactively and complete Google Sign-In.";
  }
  return "Antigravity CLI stream session failed to initialize.";
}

function isRetryableAntigravityError(message: string): boolean {
  const lower = message.toLowerCase();
  if (/quota|billing|credit|invalid model|authentication|required.*sign|terms of service/u.test(lower)) {
    return false;
  }
  return /temporar|timeout|timed out|connection|network|unavailable|capacity|rate limit|429/u.test(lower);
}

function usesWindowsCommandShell(command: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command);
}

async function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function appendBounded(values: unknown[], value: unknown, maximum: number): void {
  if (values.length >= maximum) values.shift();
  values.push(value);
}

function appendTail(value: string, chunk: string, maxBytes: number): string {
  const next = value + chunk;
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  const bytes = Buffer.from(next, "utf8");
  return bytes.subarray(bytes.length - maxBytes).toString("utf8");
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
