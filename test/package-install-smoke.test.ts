import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTestDevspaceConfig } from "../src/test-support/config.test.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

testPackedPackageLaunchers();

function testPackedPackageLaunchers(): void {
  const root = mkdtempSync(join(tmpdir(), "devspace-packed-bin-test-"));
  const installRoot = join(root, "install");
  try {
    mkdirSync(installRoot, { recursive: true });
    execCommand(npmExecutable(), ["pack", "--silent", "--pack-destination", root], {
      cwd: projectRoot,
    });
    const archive = readdirSync(root).find((name) => name.endsWith(".tgz"));
    assert.ok(archive, "npm pack must produce a package archive");

    execCommand(npmExecutable(), [
      "install",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      "--omit=optional",
      join(root, archive),
    ], {
      cwd: installRoot,
    });

    const configRoot = join(root, "config");
    const env = writeTestDevspaceConfig(configRoot, {
      storage: { stateDir: join(root, "state") },
      workspaces: { allowedRoots: [root], worktreeRoot: join(root, "worktrees") },
      skills: { agentDir: join(root, "agents") },
    });
    const cliOutput = execInstalledPackageBin(installRoot, "devspace", ["config", "get"], {
      ...process.env,
      ...env,
    });
    const config = JSON.parse(cliOutput) as { tools?: { mode?: string } };
    assert.equal(config.tools?.mode, "codex");

    execInstalledPackageBin(installRoot, "devspace-agentd", [], {
      ...process.env,
      ...env,
      DEVSPACE_AGENTD_IDLE_TIMEOUT_MS: "0",
      DEVSPACE_AGENTD_SHUTDOWN_TIMEOUT_MS: "1000",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function execInstalledPackageBin(
  installRoot: string,
  name: "devspace" | "devspace-agentd",
  args: string[],
  env: NodeJS.ProcessEnv,
): string {
  const packageRoot = findInstalledPackageRoot(
    join(installRoot, "node_modules"),
    "@waishnav/devspace",
  );
  assert.ok(packageRoot, "packed @waishnav/devspace package must be installed");
  const entrypoint = join(
    packageRoot,
    "bin",
    name === "devspace" ? "devspace.js" : "devspace-agentd.js",
  );
  assert.equal(
    existsSync(entrypoint),
    true,
    `packed package must contain ${entrypoint}`,
  );
  return execFileSync(process.execPath, [entrypoint, ...args], {
    encoding: "utf8",
    env,
    stdio: "pipe",
    windowsHide: true,
  });
}

function findInstalledPackageRoot(
  nodeModulesRoot: string,
  packageName: string,
): string | undefined {
  const pending = [nodeModulesRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory || !existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".bin") continue;
      const path = join(directory, entry.name);
      if (!entry.isDirectory()) continue;
      const manifestPath = join(path, "package.json");
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string };
          if (manifest.name === packageName) return path;
        } catch {
          // Ignore dependency manifests that are not valid JSON.
        }
      }
      pending.push(path);
    }
  }
  return undefined;
}

function execCommand(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const windows = process.platform === "win32";
  return execFileSync(
    windows ? process.env.ComSpec ?? "cmd.exe" : executable,
    windows ? ["/d", "/c", executable, ...args] : args,
    {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env ?? process.env,
      stdio: "pipe",
      windowsHide: true,
    },
  );
}
