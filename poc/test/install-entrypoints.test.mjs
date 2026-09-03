import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const EXPECTED = {
  version: "1.0.2",
  package_url: "https://github.com/Miniks040506/EffectGate/releases/download/v1.0.2/effectgate-preview-1.0.2.tgz",
  sha256: "9f8b288d4e2af47084cf8c4cf63d3a988b59ee7acb2b074b111a5537946a1e48",
  node_major: Number(process.versions.node.split(".")[0])
};

test("platform installer validates the pinned release without network access", () => {
  const windows = process.platform === "win32";
  const command = windows ? "powershell.exe" : "sh";
  const script = resolve(
    REPOSITORY_ROOT,
    "install",
    windows ? "install.ps1" : "install.sh"
  );
  const args = windows
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Check"]
    : [script, "--check"];
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), EXPECTED);
});
