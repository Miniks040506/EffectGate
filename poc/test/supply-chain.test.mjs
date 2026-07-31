import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const POC_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_ROOT = dirname(POC_ROOT);
const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\1/gu;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "bundledDependencies",
  "bundleDependencies"
];
const REVIEWED_ACTIONS = new Map([
  [
    "actions/checkout",
    "d23441a48e516b6c34aea4fa41551a30e30af803"
  ],
  [
    "actions/setup-node",
    "249970729cb0ef3589644e2896645e5dc5ba9c38"
  ]
]);

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test("runtime supply chain is dependency-free and action-pinned", () => {
  const manifest = JSON.parse(readFileSync(
    join(POC_ROOT, "package.json"),
    "utf8"
  ));
  for (const field of DEPENDENCY_FIELDS) {
    assert.equal(
      manifest[field],
      undefined,
      `package.json must not declare ${field}`
    );
  }

  const runtimeFiles = filesUnder(join(POC_ROOT, "src"))
    .filter((file) => extname(file) === ".mjs");
  let importCount = 0;
  for (const file of runtimeFiles) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      importCount += 1;
      assert.ok(
        match[2].startsWith("node:") || match[2].startsWith("."),
        `${file} has an unreviewed runtime import: ${match[2]}`
      );
    }
  }

  const workflowFiles = filesUnder(
    join(REPOSITORY_ROOT, ".github", "workflows")
  ).filter((file) => [".yml", ".yaml"].includes(extname(file)));
  const actionCounts = new Map();
  for (const file of workflowFiles) {
    const source = readFileSync(file, "utf8");
    const lines = source.match(/^\s*uses:\s*\S+.*$/gmu) ?? [];
    for (const line of lines) {
      const reference = line
        .replace(/^\s*uses:\s*/u, "")
        .replace(/\s+#.*$/u, "");
      const separator = reference.lastIndexOf("@");
      assert.ok(separator > 0, `${file} has an invalid action reference`);
      const action = reference.slice(0, separator);
      const revision = reference.slice(separator + 1);
      assert.equal(
        revision,
        REVIEWED_ACTIONS.get(action),
        `${file} must pin ${action} to its reviewed commit`
      );
      actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
    }
  }
  assert.deepEqual(
    Object.fromEntries(actionCounts),
    { "actions/checkout": 2, "actions/setup-node": 1 }
  );

  process.stdout.write(`${JSON.stringify({
    kind: "effectgate_supply_chain_evidence",
    runtime_files: runtimeFiles.length,
    runtime_imports: importCount,
    declared_dependencies: 0,
    pinned_action_references: 3,
    mutable_action_references: 0,
    dependency_high_findings: 0
  })}\n`);
});
