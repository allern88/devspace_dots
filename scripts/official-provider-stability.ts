#!/usr/bin/env node
import {
  parseOfficialProviderStabilityArgs,
  runOfficialProviderStability,
} from "../src/official-provider-stability.js";

try {
  const options = parseOfficialProviderStabilityArgs(process.argv.slice(2));
  const report = await runOfficialProviderStability(options);
  console.log(
    `YUNXU TrustBridge MCP official-provider report: ${report.passed ? "PASS" : "FAIL"}`,
  );
  for (const provider of report.providers) {
    console.log(
      `${provider.provider}: ${provider.passed}/${report.requirements.runsPerProvider} `
      + `(${(provider.successRate * 100).toFixed(1)}%), continuation=${provider.continuation.status}`,
    );
    if (provider.trustPolicyReason) console.log(`  ${provider.trustPolicyReason}`);
  }
  console.log(`Reports: ${options.outputDirectory}`);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
