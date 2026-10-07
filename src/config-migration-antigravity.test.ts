import assert from "node:assert/strict";
import { migrateLegacyConfig } from "./config-migration.js";

const migrated = migrateLegacyConfig({
  subagents: true,
});

assert.equal(migrated.subagents.enabled, true);
assert.equal(
  migrated.subagents.providers.some((provider) => provider.id === "antigravity"),
  false,
  "legacy boolean subagent configuration must not silently enable Antigravity",
);
for (const provider of ["codex", "claude", "opencode", "pi", "cursor", "copilot", "grok"] as const) {
  assert.equal(
    migrated.subagents.providers.some((entry) => entry.id === provider && entry.enabled),
    true,
    `legacy provider ${provider} should retain its enabled state`,
  );
}
