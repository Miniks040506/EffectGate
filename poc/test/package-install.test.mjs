import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function runNpm(args, cwd, cache) {
  assert.ok(
    process.env.npm_execpath,
    "package qualification must run through npm test"
  );
  const result = spawnSync(
    process.execPath,
    [process.env.npm_execpath, ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_cache: cache,
        npm_config_fund: "false",
        npm_config_offline: "true",
        npm_config_update_notifier: "false"
      }
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("packed CLI lifecycle preserves external state", () => {
  const root = mkdtempSync(join(tmpdir(), "effectgate-install-"));
  const packDirectory = join(root, "pack");
  const installDirectory = join(root, "consumer");
  const stateDirectory = join(root, "state");
  const cache = join(root, "npm-cache");
  mkdirSync(packDirectory);
  mkdirSync(installDirectory);
  mkdirSync(stateDirectory);
  const stateFile = join(stateDirectory, "preserve.json");
  const state = JSON.stringify({ owner: "user", revision: 17 });
  writeFileSync(stateFile, state);
  writeFileSync(
    join(installDirectory, "package.json"),
    JSON.stringify({ name: "effectgate-install-smoke", private: true })
  );

  try {
    const packed = JSON.parse(runNpm([
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packDirectory
    ], PACKAGE_ROOT, cache))[0];
    const files = new Set(packed.files.map(({ path }) => path));

    for (const required of [
      "LICENSE",
      "README.md",
      "package.json",
      "src/proxy/effectgate.mjs"
    ]) {
      assert.ok(files.has(required), `package is missing ${required}`);
    }
    assert.equal(
      [...files].some((path) => /^(?:evidence|test)\//u.test(path)),
      false
    );

    const tarball = join(packDirectory, packed.filename);
    runNpm([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball
    ], installDirectory, cache);

    const installedRoot = join(
      installDirectory,
      "node_modules",
      "effectgate-preview"
    );
    const installedCli = join(
      installedRoot,
      "src",
      "proxy",
      "effectgate.mjs"
    );
    const bin = join(
      installDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "effectgate.cmd" : "effectgate"
    );
    assert.ok(existsSync(installedCli));
    assert.ok(existsSync(bin));
    const installedManifest = JSON.parse(readFileSync(
      join(installedRoot, "package.json"),
      "utf8"
    ));
    assert.equal(installedManifest.version, packed.version);
    for (const lifecycle of [
      "preinstall", "install", "postinstall",
      "preuninstall", "uninstall", "postuninstall"
    ]) {
      assert.equal(installedManifest.scripts?.[lifecycle], undefined);
    }

    const version = spawnSync(process.execPath, [installedCli, "--version"], {
      encoding: "utf8"
    });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), packed.version);

    runNpm([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball
    ], installDirectory, cache);
    assert.equal(readFileSync(stateFile, "utf8"), state);

    const launch = spawnSync(process.execPath, [installedCli, "fixture"], {
      encoding: "utf8",
      input: `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize"
      })}\n`
    });
    assert.equal(launch.status, 0, launch.stderr);
    const response = JSON.parse(launch.stdout.trim());
    assert.equal(response.id, 1);
    assert.equal(response.result.serverInfo.name, "effectgate-fixture");
    assert.equal(response.result.serverInfo.version, packed.version);

    runNpm([
      "uninstall",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "effectgate-preview"
    ], installDirectory, cache);
    assert.equal(existsSync(installedRoot), false);
    assert.equal(existsSync(bin), false);
    assert.equal(readFileSync(stateFile, "utf8"), state);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

if (process.env.EFFECTGATE_PREVIOUS_PACKAGE) {
  test("previous package upgrades and rolls back without state loss", () => {
    const previousRoot = resolve(
      process.env.EFFECTGATE_PREVIOUS_PACKAGE
    );
    const previousCommit = process.env.EFFECTGATE_PREVIOUS_COMMIT;
    assert.match(previousCommit ?? "", /^[a-f0-9]{40}$/u);
    assert.notEqual(previousRoot, PACKAGE_ROOT);
    const previousVersion = JSON.parse(readFileSync(
      join(previousRoot, "package.json"),
      "utf8"
    )).version;
    const currentVersion = JSON.parse(readFileSync(
      join(PACKAGE_ROOT, "package.json"),
      "utf8"
    )).version;
    assert.equal(previousVersion, "0.16.0");
    assert.equal(currentVersion, "0.17.0");

    const root = mkdtempSync(join(tmpdir(), "effectgate-upgrade-"));
    const previousPack = join(root, "previous-pack");
    const currentPack = join(root, "current-pack");
    const consumer = join(root, "consumer");
    const cache = join(root, "npm-cache");
    const stateFile = join(root, "external-state.json");
    mkdirSync(previousPack);
    mkdirSync(currentPack);
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "effectgate-upgrade-smoke", private: true })
    );
    const state = JSON.stringify({ owner: "user", revision: 18 });
    writeFileSync(stateFile, state);

    try {
      const pack = (packageRoot, destination) => {
        const packed = JSON.parse(runNpm([
          "pack", "--force", "--ignore-scripts", "--json",
          "--pack-destination", destination
        ], packageRoot, cache))[0];
        return join(destination, packed.filename);
      };
      const previousTarball = pack(previousRoot, previousPack);
      const currentTarball = pack(PACKAGE_ROOT, currentPack);
      const install = (tarball) => runNpm([
        "install", "--ignore-scripts", "--no-audit", "--no-fund",
        "--package-lock=false", tarball
      ], consumer, cache);
      const installedRoot = join(
        consumer, "node_modules", "effectgate-preview"
      );
      const installedVersion = () => JSON.parse(readFileSync(
        join(installedRoot, "package.json"),
        "utf8"
      )).version;
      const bin = join(
        consumer,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "effectgate.cmd" : "effectgate"
      );

      install(previousTarball);
      assert.equal(installedVersion(), previousVersion);
      assert.equal(existsSync(bin), false);
      assert.equal(readFileSync(stateFile, "utf8"), state);

      install(currentTarball);
      assert.equal(installedVersion(), currentVersion);
      assert.equal(existsSync(bin), true);
      assert.equal(readFileSync(stateFile, "utf8"), state);

      install(previousTarball);
      assert.equal(installedVersion(), previousVersion);
      assert.equal(existsSync(bin), false);
      assert.equal(readFileSync(stateFile, "utf8"), state);

      install(currentTarball);
      assert.equal(installedVersion(), currentVersion);
      assert.equal(existsSync(bin), true);
      assert.equal(readFileSync(stateFile, "utf8"), state);

      const installedCli = join(
        installedRoot, "src", "proxy", "effectgate.mjs"
      );
      const version = spawnSync(
        process.execPath,
        [installedCli, "--version"],
        { encoding: "utf8" }
      );
      assert.equal(version.status, 0, version.stderr);
      assert.equal(version.stdout.trim(), currentVersion);
      process.stdout.write(`${JSON.stringify({
        kind: "effectgate_tier1_package_evidence",
        previous_commit: previousCommit,
        previous_version: previousVersion,
        current_version: currentVersion,
        platform: process.platform,
        architecture: process.arch,
        node_version: process.version,
        external_state_preserved: true
      })}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
