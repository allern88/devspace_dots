import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";

const snapshot = getLocalAgentProviderAvailabilitySnapshot({
  ...process.env,
  CODEX_COMMAND: "/definitely/missing/devspace-codex",
  ANTIGRAVITY_COMMAND: "/definitely/missing/devspace-agy",
  GEMINI_API_KEY: "test-key",
  AGY_ADC_AUTH: "",
});
assert.deepEqual(snapshot.find((provider) => provider.name === "codex"), {
  name: "codex",
  available: false,
  reason: "/definitely/missing/devspace-codex executable not found",
});
assert.deepEqual(snapshot.find((provider) => provider.name === "antigravity"), {
  name: "antigravity",
  available: false,
  reason: "/definitely/missing/devspace-agy executable not found",
});
assert.equal(
  getLocalAgentProviderAvailabilitySnapshot({
    ...process.env,
    CODEX_COMMAND: "",
    ANTIGRAVITY_COMMAND: "",
    GEMINI_API_KEY: "test-key",
    AGY_ADC_AUTH: "",
  }).find((provider) => provider.name === "codex")?.available,
  false,
);

const personalOauthOnly = getLocalAgentProviderAvailabilitySnapshot({
  ...process.env,
  ANTIGRAVITY_COMMAND: "/usr/bin/agy",
  GEMINI_API_KEY: "",
  AGY_ADC_AUTH: "",
}).find((provider) => provider.name === "antigravity");
assert.equal(personalOauthOnly?.available, false);
assert.equal(personalOauthOnly?.note, "blocked_by_trust_policy");
assert.match(personalOauthOnly?.reason ?? "", /Personal Antigravity\/Google AI Pro OAuth/);

{
  const directory = mkdtempSync(join(tmpdir(), "devspace-provider-command-"));
  const executable = join(directory, "codex-wrapper");
  const antigravityExecutable = join(
    directory,
    process.platform === "win32" ? "agy.cmd" : "agy",
  );
  try {
    assert.equal(
      getLocalAgentProviderAvailabilitySnapshot({
        ...process.env,
        CODEX_COMMAND: directory,
        ANTIGRAVITY_COMMAND: directory,
        GEMINI_API_KEY: "test-key",
        AGY_ADC_AUTH: "",
      }).find((provider) => provider.name === "codex")?.available,
      false,
    );
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);
    writeFileSync(
      antigravityExecutable,
      process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
    );
    chmodSync(antigravityExecutable, 0o700);
    const providerConfig = {
      enabled: true,
      instructions: "on-demand" as const,
      providers: [
        {
          id: "codex" as const,
          enabled: true,
          command: executable,
          env: { OPENAI_API_KEY: "configured-secret", EMPTY_VALUE: "" },
        },
        {
          id: "antigravity" as const,
          enabled: true,
          command: antigravityExecutable,
          env: {
            ANTIGRAVITY_BASE_URL: "https://antigravity.google",
            GEMINI_API_KEY: "configured-google-secret",
            AGY_ADC_AUTH: "",
          },
        },
      ],
    };
    const availability = getLocalAgentProviderAvailabilitySnapshot(
      {
        ...process.env,
        CODEX_COMMAND: "/definitely/missing/devspace-codex",
        ANTIGRAVITY_COMMAND: "/definitely/missing/devspace-agy",
        OPENAI_API_KEY: "must-not-appear",
        GEMINI_API_KEY: "must-not-appear-either",
        AGY_ADC_AUTH: "",
      },
      providerConfig,
    );
    assert.deepEqual(availability.find((provider) => provider.name === "codex"), {
      name: "codex",
      available: true,
      note: "available",
    });
    assert.deepEqual(availability.find((provider) => provider.name === "antigravity"), {
      name: "antigravity",
      available: true,
    });
    assert.doesNotMatch(
      JSON.stringify(availability),
      /configured-secret|must-not-appear|configured-google-secret/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
