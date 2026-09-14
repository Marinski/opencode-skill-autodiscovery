import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../dist/index.js";

// Regression guard for the bug this whole cache layer exists to fix: on this
// project's own host, opencode-skill-autodiscovery blocked opencode's
// startup for 4+ minutes because collectClaude's fallback walk synchronously
// read every .md file across a 27,676-file, 788MB marketplace tree on every
// single launch. This test builds a smaller but still "many files across
// many directories" tree (the same flat agency-agents shape) and asserts a
// warm run — an unchanged tree on the second scan — stays fast in absolute
// terms, not just relative to a cold run (a relative-only assertion would
// still pass if both got slower together).
const PACKAGE_COUNT = 30;
const FILES_PER_PACKAGE = 100; // 3,000 .md files total, same flat layout as the real host tree
const WARM_RUN_BUDGET_MS = 1500;

let envRoot;
let oldEnv = {};

before(() => {
  envRoot = mkdtempSync(join(tmpdir(), "oc-perf-"));
  oldEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };
  process.env.HOME = envRoot;
  process.env.USERPROFILE = envRoot;
  delete process.env.XDG_CACHE_HOME;
  delete process.env.XDG_STATE_HOME;
  process.chdir(envRoot);

  const marketRoot = join(envRoot, "market", "agent-plugins");
  for (let p = 0; p < PACKAGE_COUNT; p++) {
    const pkgDir = join(marketRoot, `division-${p}`);
    mkdirSync(pkgDir, { recursive: true });
    for (let f = 0; f < FILES_PER_PACKAGE; f++) {
      // Filenames must be globally unique across packages: readAgents keys an
      // agent by its filename, and the plugin's (correct, separately tested)
      // same-source dedup treats an identically-named agent from a later
      // package sharing this fixture's source as a mirror of the first, not
      // a distinct agent — reusing "agent-0.md" etc. across divisions would
      // silently collapse 30 packages' agents down to one package's.
      writeFileSync(
        join(pkgDir, `agent-${p}-${f}.md`),
        `---\nname: Agent ${p}-${f}\ndescription: Synthetic agent ${p}-${f}\n---\nYou are agent ${p}-${f}.`,
      );
    }
  }
});

after(() => {
  for (const [k, v] of Object.entries(oldEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(envRoot, { recursive: true, force: true });
});

test(`performance: a warm run over ${PACKAGE_COUNT * FILES_PER_PACKAGE} flat .md files stays fast, and discovers all of them either way`, async () => {
  const hooks = await plugin({}, { extraRoots: ["market"], agents: true });

  const cold = { skills: { paths: [] } };
  const coldStart = performance.now();
  await hooks.config(cold);
  const coldMs = performance.now() - coldStart;

  const warm = { skills: { paths: [] } };
  const warmStart = performance.now();
  await hooks.config(warm);
  const warmMs = performance.now() - warmStart;

  const coldAgentCount = Object.keys(cold.agent ?? {}).length;
  const warmAgentCount = Object.keys(warm.agent ?? {}).length;
  assert.equal(
    coldAgentCount,
    PACKAGE_COUNT * FILES_PER_PACKAGE,
    "every synthetic agent must be discovered on the cold run",
  );
  assert.equal(
    warmAgentCount,
    coldAgentCount,
    "the warm run must discover exactly the same agents as the cold run",
  );

  assert.ok(
    warmMs < WARM_RUN_BUDGET_MS,
    `warm run took ${warmMs.toFixed(1)}ms, over the ${WARM_RUN_BUDGET_MS}ms budget ` +
      `(cold run took ${coldMs.toFixed(1)}ms) — the whole-root cache is not actually ` +
      "skipping the re-walk",
  );
});
