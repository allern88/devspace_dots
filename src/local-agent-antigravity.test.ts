import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AntigravityLocalAgentDriver,
  AntigravityStreamRuntime,
  antigravityArguments,
  assertOfficialAntigravityCommand,
  assertOfficialAntigravityEndpoints,
  isOfficialGoogleEndpoint,
} from "./local-agent-antigravity.js";

assert.deepEqual(
  antigravityArguments({
    providerSessionId: "conversation_existing",
    writeMode: "allowed",
    model: "gemini-3-pro",
    effort: "high",
    printTimeout: "2m",
  }),
  [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--print-timeout",
    "2m",
    "--conversation",
    "conversation_existing",
    "--model",
    "gemini-3-pro",
    "--effort",
    "high",
    "--sandbox",
  ],
);
assert.ok(antigravityArguments({ writeMode: "full_access" })
  .includes("--dangerously-skip-permissions"));
assert.equal(isOfficialGoogleEndpoint("https://antigravity.google/api"), true);
assert.equal(isOfficialGoogleEndpoint("https://generativelanguage.googleapis.com/v1"), true);
assert.equal(isOfficialGoogleEndpoint("http://127.0.0.1:9999"), true);
assert.equal(isOfficialGoogleEndpoint("https://developer-relay.example/api"), false);
assert.doesNotThrow(() => assertOfficialAntigravityCommand("C:\\Tools\\agy.exe"));
assert.throws(
  () => assertOfficialAntigravityCommand("C:\\Tools\\agy-wrapper.exe"),
  /Official-only policy rejected ANTIGRAVITY_COMMAND/,
);
assert.doesNotThrow(() => assertOfficialAntigravityEndpoints({
  ANTIGRAVITY_BASE_URL: "https://antigravity.google",
  GEMINI_API_BASE_URL: "https://generativelanguage.googleapis.com/v1",
}));
assert.throws(
  () => assertOfficialAntigravityEndpoints({
    ANTIGRAVITY_BASE_URL: "https://developer-relay.example/v1",
  }),
  /Official-only policy rejected ANTIGRAVITY_BASE_URL/,
);

const unavailable = await new AntigravityLocalAgentDriver(
  {},
  () => undefined,
).createRuntime({
  agentId: "agt_missing",
  provider: "antigravity",
  workspaceRoot: process.cwd(),
  writeMode: "allowed",
});
assert.equal(unavailable.isErr(), true);
if (unavailable.isErr()) {
  assert.equal(unavailable.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(unavailable.error.retryable, false);
}

const readOnly = await new AntigravityLocalAgentDriver(
  {},
  () => ({ executable: process.platform === "win32" ? "C:\\Tools\\agy.exe" : "/opt/bin/agy" }),
).createRuntime({
  agentId: "agt_read_only",
  provider: "antigravity",
  workspaceRoot: process.cwd(),
  writeMode: "read_only",
});
assert.equal(readOnly.isErr(), true);
if (readOnly.isErr()) {
  assert.equal(readOnly.error.code, "PROVIDER_UNAVAILABLE");
  assert.match(readOnly.error.message, /read_only semantics/);
}

const root = await mkdtemp(join(tmpdir(), "devspace-antigravity-stream-test-"));
try {
  const implementation = join(root, "fake-agy.mjs");
  await writeFile(implementation, `import readline from "node:readline";
let turn = 0;
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
output({
  event: "init",
  conversation_id: process.argv.includes("--conversation")
    ? process.argv[process.argv.indexOf("--conversation") + 1]
    : "conversation_new",
  init: { cwd: process.cwd(), tools: ["run_command"], permission_mode: "request-review" },
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const content = typeof message.message?.content === "string"
    ? message.message.content
    : message.message?.content?.map((part) => part.text || "").join("") || "";
  turn += 1;
  const conversationId = process.argv.includes("--conversation")
    ? process.argv[process.argv.indexOf("--conversation") + 1]
    : "conversation_new";
  output({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: turn,
      state: "DONE",
      step_type: "agent_response",
      text_delta: content,
    },
  });
  if (content === "fail") {
    output({ event: "result", result: {
      conversation_id: conversationId,
      status: "ERROR",
      response: "",
      error: "temporary connection failure",
    } });
    return;
  }
  if (content === "cancel") {
    output({ event: "result", result: {
      conversation_id: conversationId,
      status: "CANCELED",
      response: "",
      error: "cancelled by test",
    } });
    return;
  }
  if (content === "empty") {
    output({ event: "result", result: {
      conversation_id: conversationId,
      status: "SUCCESS",
      response: "",
    } });
    return;
  }
  output({ event: "result", result: {
    conversation_id: conversationId,
    status: "SUCCESS",
    response: "fake response " + turn,
    usage: { total_tokens: turn * 10 },
  } });
});
`, { mode: 0o700 });

  const command = process.platform === "win32"
    ? join(root, "agy.cmd")
    : join(root, "agy");
  if (process.platform === "win32") {
    await writeFile(
      command,
      `@echo off\r\n"${process.execPath}" "%~dp0\\fake-agy.mjs" %*\r\n`,
    );
  } else {
    await writeFile(
      command,
      `#!/bin/sh\nexec "${process.execPath}" "${implementation}" "$@"\n`,
      { mode: 0o700 },
    );
    await chmod(command, 0o700);
  }

  const runtime = new AntigravityStreamRuntime({
    command,
    env: process.env,
    workspaceRoot: root,
    writeMode: "allowed",
    model: "gemini-test",
    effort: "medium",
  });
  try {
    assert.equal(await runtime.initialize(), "conversation_new");
    let sessionId: string | undefined;
    const firstResult = await runtime.run({
      prompt: "first",
      workspaceRoot: root,
      writeMode: "allowed",
      model: "gemini-test",
      effort: "medium",
    }, { onSessionId: (value) => { sessionId = value; } });
    assert.equal(firstResult.isOk(), true);
    if (firstResult.isErr()) throw firstResult.error;
    assert.equal(sessionId, "conversation_new");
    assert.equal(firstResult.value.providerSessionId, "conversation_new");
    assert.equal(firstResult.value.finalResponse, "fake response 1");
    assert.equal(firstResult.value.items.length, 2);

    const secondResult = await runtime.run({
      prompt: "second",
      workspaceRoot: root,
      providerSessionId: "conversation_new",
      writeMode: "allowed",
      model: "gemini-test",
      effort: "medium",
    });
    assert.equal(secondResult.isOk(), true);
    if (secondResult.isErr()) throw secondResult.error;
    assert.equal(secondResult.value.finalResponse, "fake response 2");

    const executionFailure = await runtime.run({
      prompt: "fail",
      workspaceRoot: root,
      providerSessionId: "conversation_new",
      writeMode: "allowed",
      model: "gemini-test",
      effort: "medium",
    });
    assert.equal(executionFailure.isErr(), true);
    if (executionFailure.isErr()) {
      assert.equal(executionFailure.error.code, "PROVIDER_EXECUTION_ERROR");
      assert.equal(executionFailure.error.retryable, true);
    }

    const cancelled = await runtime.run({
      prompt: "cancel",
      workspaceRoot: root,
      providerSessionId: "conversation_new",
      writeMode: "allowed",
      model: "gemini-test",
      effort: "medium",
    });
    assert.equal(cancelled.isErr(), true);
    if (cancelled.isErr()) assert.equal(cancelled.error.code, "PROVIDER_CANCELLED");

    const protocolFailure = await runtime.run({
      prompt: "empty",
      workspaceRoot: root,
      providerSessionId: "conversation_new",
      writeMode: "allowed",
      model: "gemini-test",
      effort: "medium",
    });
    assert.equal(protocolFailure.isErr(), true);
    if (protocolFailure.isErr()) {
      assert.equal(protocolFailure.error.code, "PROVIDER_PROTOCOL_ERROR");
    }
  } finally {
    await runtime.close();
    await runtime.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
