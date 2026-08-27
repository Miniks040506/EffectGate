#!/usr/bin/env node

import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const VERSION = /^\d+\.\d+\.\d+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PLATFORMS = new Set(["linux", "macos", "windows"]);
const USAGE =
  "Usage: native-package-stage.mjs --package DIRECTORY --output DIRECTORY " +
  "--platform linux|macos|windows --version VERSION --sha256 HEX";

const POSIX_LAUNCHER = `#!/usr/bin/env sh
set -eu
command -v node >/dev/null 2>&1 || {
  echo "EffectGate requires Node.js 24 or newer." >&2
  exit 1
}
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || {
  echo "EffectGate requires Node.js 24 or newer." >&2
  exit 1
}
prefix=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
exec node "$prefix/lib/effectgate-preview/package/src/proxy/effectgate.mjs" "$@"
`;

const WINDOWS_LAUNCHER = `@echo off
where node >nul 2>nul || (
  echo EffectGate requires Node.js 24 or newer. 1>&2
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" >nul 2>nul || (
  echo EffectGate requires Node.js 24 or newer. 1>&2
  exit /b 1
)
node "%~dp0package\\src\\proxy\\effectgate.mjs" %*
`;

function assertPlainTree(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error("package payload cannot contain symbolic links");
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) pending.push(join(current, entry));
    } else if (!stat.isFile()) {
      throw new Error("package payload contains an unsupported file type");
    }
  }
}

function writeMetadata(directory, version, sha256) {
  writeFileSync(join(directory, "release.json"), `${JSON.stringify({
    package: "effectgate-preview",
    version,
    source_package_sha256: sha256
  })}\n`, { flag: "wx" });
}

export function stageNativePackage({
  packageDirectory,
  output,
  platform,
  version,
  sha256
} = {}) {
  if (
    typeof packageDirectory !== "string" ||
    packageDirectory.length < 1 ||
    typeof output !== "string" ||
    output.length < 1 ||
    !PLATFORMS.has(platform) ||
    !VERSION.test(version ?? "") ||
    !SHA256.test(sha256 ?? "")
  ) {
    throw new TypeError("invalid native package staging configuration");
  }
  const packageRoot = resolve(packageDirectory);
  const outputRoot = resolve(output);
  const outputFromPackage = relative(packageRoot, outputRoot);
  if (!existsSync(packageRoot) || existsSync(outputRoot)) {
    throw new Error("package source must exist and output must not exist");
  }
  if (
    outputFromPackage === "" ||
    (!outputFromPackage.startsWith("..") && !isAbsolute(outputFromPackage))
  ) {
    throw new Error("native package output cannot be inside the source payload");
  }
  assertPlainTree(packageRoot);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (
    manifest.name !== "effectgate-preview" ||
    manifest.version !== version ||
    manifest.license !== "Apache-2.0" ||
    manifest.engines?.node !== ">=24" ||
    !existsSync(join(packageRoot, "src", "proxy", "effectgate.mjs"))
  ) {
    throw new Error("package payload identity does not match the native package");
  }

  if (platform === "windows") {
    mkdirSync(outputRoot, { recursive: true });
    cpSync(packageRoot, join(outputRoot, "package"), { recursive: true });
    writeFileSync(join(outputRoot, "effectgate.cmd"), WINDOWS_LAUNCHER, {
      flag: "wx"
    });
    writeMetadata(outputRoot, version, sha256);
    return Object.freeze({ output: outputRoot, launcher: "effectgate.cmd" });
  }

  const prefix = platform === "macos" ? join("usr", "local") : "usr";
  const installRoot = join(outputRoot, prefix, "lib", "effectgate-preview");
  const bin = join(outputRoot, prefix, "bin");
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(bin, { recursive: true });
  cpSync(packageRoot, join(installRoot, "package"), { recursive: true });
  const launcher = join(bin, "effectgate");
  writeFileSync(launcher, POSIX_LAUNCHER, { flag: "wx" });
  chmodSync(launcher, 0o755);
  writeMetadata(installRoot, version, sha256);
  return Object.freeze({ output: outputRoot, launcher: join(prefix, "bin", "effectgate") });
}

function parseArguments(args) {
  if (args.length !== 10) throw new Error(USAGE);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith("--") || values.has(args[index])) {
      throw new Error(USAGE);
    }
    values.set(args[index], args[index + 1]);
  }
  const expected = ["--package", "--output", "--platform", "--version", "--sha256"];
  if (expected.some((name) => !values.has(name)) || values.size !== expected.length) {
    throw new Error(USAGE);
  }
  return {
    packageDirectory: values.get("--package"),
    output: values.get("--output"),
    platform: values.get("--platform"),
    version: values.get("--version"),
    sha256: values.get("--sha256")
  };
}

export function main(args = process.argv.slice(2)) {
  const result = stageNativePackage(parseArguments(args));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[effectgate-native-package] ${error.message}\n`);
    process.exitCode = 1;
  }
}
