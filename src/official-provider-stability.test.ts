import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseOfficialProviderStabilityArgs,
  renderOfficialProviderReport,
  writeOfficialProviderReports,
  type OfficialProviderStabilityReport,
} from "./official-provider-stability.js";

const parsed = parseOfficialProviderStabilityArgs([
  "--providers",
  "codex,antigravity",
  "--runs",
  "30",
  "--timeout",
  "420",
  "--minimum-success-rate",
  "0.966",
  "--workspace",
  "./project",
  "--output",
  "./evidence",
  "--cli",
  "./dist/cli.js",
  "--no-continuation",
], "/workspace");
assert.deepEqual(parsed.providers, ["codex", "antigravity"]);
assert.equal(parsed.runs, 30);
assert.equal(parsed.timeoutSeconds, 420);
assert.equal(parsed.minimumSuccessRate, 0.966);
assert.equal(parsed.workspaceRoot, resolve("./project"));
assert.equal(parsed.outputDirectory, resolve("./evidence"));
assert.equal(parsed.cliPath, resolve("./dist/cli.js"));
assert.equal(parsed.continuationCheck, false);
assert.throws(
  () => parseOfficialProviderStabilityArgs(["--providers", "developer-relay"], "/workspace"),
  /Unsupported official provider/,
);
assert.throws(
  () => parseOfficialProviderStabilityArgs(["--runs", "0"], "/workspace"),
  /positive integer/,
);
assert.throws(
  () => parseOfficialProviderStabilityArgs(["--minimum-success-rate", "1.2"], "/workspace"),
  /between 0 and 1/,
);

const report: OfficialProviderStabilityReport = {
  schema: "yunxu-trustbridge/provider-stability/v1",
  project: "YUNXU TrustBridge MCP",
  startedAt: "2026-10-07T12:00:00.000Z",
  finishedAt: "2026-10-07T12:05:00.000Z",
  workspaceRoot: "/workspace/project",
  providers: [
    {
      provider: "codex",
      installedAndEnabled: true,
      trustPolicyAllowed: true,
      runs: [
        {
          run: 1,
          agentId: "agt_codex",
          status: "passed",
          durationMs: 1000,
          markerMatched: true,
          responseSha256: "a".repeat(64),
          responseBytes: 80,
        },
      ],
      continuation: {
        status: "passed",
        agentId: "agt_codex",
        durationMs: 500,
        markerMatched: true,
        responseSha256: "b".repeat(64),
        responseBytes: 84,
      },
      passed: 1,
      failed: 0,
      successRate: 1,
      meetsThreshold: true,
    },
    {
      provider: "antigravity",
      installedAndEnabled: false,
      trustPolicyAllowed: true,
      runs: [],
      continuation: { status: "not_run" },
      passed: 0,
      failed: 1,
      successRate: 0,
      meetsThreshold: false,
    },
  ],
  requirements: {
    runsPerProvider: 1,
    minimumSuccessRate: 0.966,
    timeoutSeconds: 300,
    continuationCheck: true,
  },
  security: {
    policy: "official-only",
    credentials: "owned-by-official-client-or-os-keyring",
    responseStorage: "sha256-and-byte-count-only",
    egressObservation:
      "endpoint-overrides-validated; packet-level-egress-capture-not-performed",
  },
  passed: false,
};
const markdown = renderOfficialProviderReport(report);
assert.match(markdown, /YUNXU TrustBridge MCP/);
assert.match(markdown, /codex \| yes \| allowed \| 1\/1 \| 100\.0%/);
assert.match(markdown, /antigravity \| no \| allowed \| 0\/1 \| 0\.0%/);
assert.doesNotMatch(markdown, /agt_codex|a{64}|b{64}/);

const output = await mkdtemp(join(tmpdir(), "devspace-provider-report-test-"));
try {
  await writeOfficialProviderReports(report, output);
  const json = JSON.parse(await readFile(
    join(output, "official-provider-results.json"),
    "utf8",
  )) as OfficialProviderStabilityReport;
  const markdownFile = await readFile(
    join(output, "OFFICIAL_PROVIDER_E2E_REPORT.md"),
    "utf8",
  );
  assert.equal(json.schema, report.schema);
  assert.equal(json.security.responseStorage, "sha256-and-byte-count-only");
  assert.equal(markdownFile, markdown);
} finally {
  await rm(output, { recursive: true, force: true });
}
