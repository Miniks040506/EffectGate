import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resolveEnvironmentSecretRefs
} from "../src/config/layered-config.mjs";
import { backendEnvironment } from "../src/proxy/jsonl-rpc.mjs";
import {
  createConfiguredSkillMcp,
  loadSkillMcpConfigBundle
} from "../src/skill/skill-runtime-config.mjs";
import { importSkillSource } from "../src/skill/source-import.mjs";
import {
  STDIO_EFFECT_DRIVER,
  stdioEffectAdapterSourceDigest
} from "../src/skill/stdio-effect-adapter.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

test("configuration layers are parent-first and secrets resolve in memory",
  () => {
    const root = mkdtempSync(join(tmpdir(), "effectgate-config-layers-"));
    const parent = join(root, "base.json");
    const childDirectory = join(root, "profile");
    const child = join(childDirectory, "effectgate.json");
    mkdirSync(childDirectory);
    writeFileSync(parent, JSON.stringify({
      schema_version: "1.0.0",
      driver: STDIO_EFFECT_DRIVER,
      state_directory: join(root, "state"),
      skill_root: join(root, "skill"),
      skill_source_digest: digest("a"),
      transaction_id: "base-transaction",
      principal_id: "base-principal",
      client_id: "local-client",
      target_path: "docs/guide.md",
      resource_scope: "repo:fixture/path:docs/guide.md",
      backend_source_digest: digest("b"),
      approval_mode: "cli",
      secret_refs: {
        BACKEND_TOKEN: "env:EFFECTGATE_BASE_TOKEN"
      }
    }));
    writeFileSync(child, JSON.stringify({
      extends: "../base.json",
      transaction_id: "profile-transaction",
      principal_id: "profile-principal",
      secret_refs: {
        BACKEND_TOKEN: "env:EFFECTGATE_ROTATED_TOKEN",
        SIGNING_TOKEN: "env:EFFECTGATE_SIGNING_TOKEN"
      }
    }));
    try {
      const loaded = loadSkillMcpConfigBundle(child);
      assert.deepEqual(loaded.layers, [
        realpathSync(parent), realpathSync(child)
      ]);
      assert.equal(loaded.config.transaction_id, "profile-transaction");
      assert.equal(loaded.config.client_id, "local-client");
      assert.deepEqual(loaded.config.secret_refs, {
        BACKEND_TOKEN: "env:EFFECTGATE_ROTATED_TOKEN",
        SIGNING_TOKEN: "env:EFFECTGATE_SIGNING_TOKEN"
      });
      const secrets = resolveEnvironmentSecretRefs(
        loaded.config.secret_refs,
        {
          EFFECTGATE_ROTATED_TOKEN: "SYNTHETIC_ROTATED_SECRET",
          EFFECTGATE_SIGNING_TOKEN: "SYNTHETIC_SIGNING_SECRET"
        }
      );
      assert.deepEqual(secrets, {
        BACKEND_TOKEN: "SYNTHETIC_ROTATED_SECRET",
        SIGNING_TOKEN: "SYNTHETIC_SIGNING_SECRET"
      });
      const childEnvironment = backendEnvironment(secrets);
      assert.equal(
        childEnvironment.BACKEND_TOKEN,
        "SYNTHETIC_ROTATED_SECRET"
      );
      assert.equal(
        JSON.stringify(loaded).includes("SYNTHETIC_ROTATED_SECRET"),
        false
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test("layer cycles, raw secret values, and unavailable references fail closed",
  () => {
    const root = mkdtempSync(join(tmpdir(), "effectgate-config-invalid-"));
    const first = join(root, "first.json");
    const second = join(root, "second.json");
    writeFileSync(first, JSON.stringify({ extends: "second.json" }));
    writeFileSync(second, JSON.stringify({ extends: "first.json" }));
    try {
      assert.throws(() => loadSkillMcpConfigBundle(first), TypeError);
      assert.throws(
        () => resolveEnvironmentSecretRefs(
          { BACKEND_TOKEN: "RAW_SECRET_MUST_NOT_BE_A_REFERENCE" },
          {}
        ),
        TypeError
      );
      assert.throws(
        () => resolveEnvironmentSecretRefs(
          { PATH: "env:EFFECTGATE_TOKEN" },
          { EFFECTGATE_TOKEN: "SYNTHETIC_SECRET" }
        ),
        TypeError
      );
      assert.throws(
        () => resolveEnvironmentSecretRefs(
          { BACKEND_TOKEN: "env:EFFECTGATE_MISSING_TOKEN" },
          {}
        ),
        TypeError
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test("missing secret references fail before protected runtime state exists",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "effectgate-config-secret-"));
    const skillRoot = join(root, "skill");
    const stateDirectory = join(root, "state");
    mkdirSync(join(skillRoot, "phases"), { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "Preserve the original until verification.\n"
    );
    writeFileSync(
      join(skillRoot, "phases", "modify.md"),
      "Apply only the reviewed patch.\n"
    );
    const source = importSkillSource({
      root: skillRoot,
      paths: ["SKILL.md", "phases/modify.md"]
    });
    const configFile = join(root, "effectgate.json");
    writeFileSync(configFile, JSON.stringify({
      schema_version: "1.0.0",
      driver: STDIO_EFFECT_DRIVER,
      state_directory: stateDirectory,
      skill_root: skillRoot,
      skill_source_digest: source.source_digest,
      transaction_id: "missing-secret-transaction",
      principal_id: "local-principal",
      client_id: "local-client",
      target_path: "docs/guide.md",
      resource_scope: "repo:fixture/path:docs/guide.md",
      backend_source_digest: stdioEffectAdapterSourceDigest(),
      secret_refs: {
        BACKEND_TOKEN: "env:EFFECTGATE_TEST_MISSING_SECRET"
      }
    }));
    try {
      await assert.rejects(
        createConfiguredSkillMcp(configFile),
        TypeError
      );
      assert.equal(existsSync(stateDirectory), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
