import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { stageNativePackage } from "../src/release/native-package-stage.mjs";

const VERSION = "1.0.2";
const SHA256 = "9f8b288d4e2af47084cf8c4cf63d3a988b59ee7acb2b074b111a5537946a1e48";

function fixture(root) {
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "src", "proxy"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "effectgate-preview",
    version: VERSION,
    license: "Apache-2.0",
    engines: { node: ">=24" }
  }));
  writeFileSync(
    join(packageRoot, "src", "proxy", "effectgate.mjs"),
    "process.stdout.write('1.0.2\\n');\n"
  );
  return packageRoot;
}

test("native staging creates relocatable Windows payload", () => {
  const root = mkdtempSync(join(tmpdir(), "effectgate-native-windows-"));
  try {
    const output = join(root, "output");
    const result = stageNativePackage({
      packageDirectory: fixture(root),
      output,
      platform: "windows",
      version: VERSION,
      sha256: SHA256
    });
    assert.equal(result.launcher, "effectgate.cmd");
    assert.match(readFileSync(join(output, "effectgate.cmd"), "utf8"), /%~dp0package/u);
    assert.equal(
      JSON.parse(readFileSync(join(output, "release.json"), "utf8"))
        .source_package_sha256,
      SHA256
    );
    assert.equal(
      readFileSync(join(output, "package", "src", "proxy", "effectgate.mjs"), "utf8"),
      "process.stdout.write('1.0.2\\n');\n"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [platform, prefix] of [
  ["linux", join("usr")],
  ["macos", join("usr", "local")]
]) {
  test(`native staging creates ${platform} payload and command launcher`, () => {
    const root = mkdtempSync(join(tmpdir(), `effectgate-native-${platform}-`));
    try {
      const output = join(root, "output");
      stageNativePackage({
        packageDirectory: fixture(root),
        output,
        platform,
        version: VERSION,
        sha256: SHA256
      });
      const command = join(output, prefix, "bin", "effectgate");
      assert.equal(lstatSync(command).isFile(), true);
      if (process.platform !== "win32") {
        assert.equal(lstatSync(command).mode & 0o777, 0o755);
      }
      assert.match(readFileSync(command, "utf8"), /lib\/effectgate-preview/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("native staging rejects mismatched and linked package payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "effectgate-native-invalid-"));
  try {
    const packageRoot = fixture(root);
    assert.throws(() => stageNativePackage({
      packageDirectory: packageRoot,
      output: join(root, "wrong-version"),
      platform: "linux",
      version: "1.0.0",
      sha256: SHA256
    }), /identity/u);
    assert.throws(() => stageNativePackage({
      packageDirectory: packageRoot,
      output: join(packageRoot, "recursive-output"),
      platform: "linux",
      version: VERSION,
      sha256: SHA256
    }), /inside the source/u);
    if (process.platform !== "win32") {
      symlinkSync("package.json", join(packageRoot, "linked-manifest"));
      assert.throws(() => stageNativePackage({
        packageDirectory: packageRoot,
        output: join(root, "linked"),
        platform: "linux",
        version: VERSION,
        sha256: SHA256
      }), /symbolic links/u);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
