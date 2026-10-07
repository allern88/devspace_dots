import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";
import type { SubagentsConfig } from "./local-agent-config.js";

const snapshot = getLocalAgentProviderAvailabilitySnapshot({
  ...process.env,
  CODEX_COMMAND: "/definitely/missing/devspace-codex",
  ANTIGRAVITY_COMMAND: "/definitely/missing/devspace-agy",
  GEMINI_API_KEY: "",
  AGY_ADC_AUTH: "true",
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
    GEMINI_API_KEY: "",
    AGY_ADC_AUTH: "true",
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
        GEMINI_API_KEY: "",
        AGY_ADC_AUTH: "true",
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
    const providerConfig: SubagentsConfig = {
      enabled: true,
      instructions: "on-demand",
      providers: [
        {
          id: "codex",
          enabled: true,
          command: executable,
          env: { OPENAI_API_KEY: "configured-secret", EMPTY_VALUE: "" },
        },
        {
          id: "antigravity",
          enabled: true,
          command: antigravityExecutable,
          env: {
            ANTIGRAVITY_BASE_URL: "https://antigravity.google",
            GEMINI_API_KEY: "",
            AGY_ADC_AUTH: "true",
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
      /configured-secret|must-not-appear/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
