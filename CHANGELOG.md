# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - Unreleased

### Fixed

- **Startup could block opencode for minutes on a large, unchanged Claude/VS
  Code plugin tree.** `collectClaude`'s and `collectVscode`'s fallback walks
  (`findPluginRoots`) always ran, and always re-read and re-parsed every
  candidate file's frontmatter, on every single opencode launch — on a large
  synced marketplace (tens of thousands of files) this was long enough to be
  indistinguishable from a hang, since it fully blocks the event loop with no
  intermediate output. Two new fingerprint-gated caches (`discovery-cache.ts`)
  now skip re-walking and re-reading a subtree whose stat signature hasn't
  changed since the last run: one for the whole-tree walk result, one for a
  single package's extracted agents (the flat `*.md`-per-agent marketplace
  layout otherwise re-reads every file per package even once the top-level
  walk itself is cached). A cold run costs the same as before; a warm run on
  an unchanged tree is close to instant. See `discovery-cache.test.js` and
  `performance.test.js` for the correctness and regression-guard coverage.

### Added

- **Rigorous schema validation against the published Agent Plugins schemas**,
  not just a hand-copied field list. `plugin.json` and each `mcp.json` server
  entry are validated with `ajv` against `plugin.schema.json`/`mcp.schema.json`
  (vendored under `src/schemas/`, version 1.0.0 — the only version published
  today), the plugin's first runtime dependency. This is stricter in two
  concrete ways: a `plugin.json` with an unrecognized top-level field (the
  spec's sanctioned place for custom data is `extensions.<namespace>`, not a
  loose top-level key) is no longer silently accepted, and an MCP server entry
  declaring the reserved `PLUGIN_ROOT`/`PLUGIN_DATA` env keys is now rejected
  outright rather than having just those two keys silently dropped. A
  `plugin.json`/`mcp.json` declaring any Agent Plugins version other than the
  vendored 1.0.0 keeps the prior (looser) hand-rolled checks, so a future
  1.x.x version is never rejected just because this plugin hasn't vendored
  its schema yet. See `spec-schema.ts` and the "reserved PLUGIN_ROOT/
  PLUGIN_DATA env keys" tests in `discovery.test.js`.

### Security

- VS Code manifests (`installed.json`, `cache.json`) discovered under a
  user-supplied `extraRoots` entry are now untrusted, and the package roots
  they name must resolve inside that entry. Built-in VS Code home roots keep
  their current behavior and may still reference a global extension directory.

## [2.0.0] - 2026-08-24

This release contains a breaking change, so the major version is bumped from
1.x to 2.0.0.

### Changed

- **Breaking:** behavioral change to discovery defaults. `scanNodeModules` and
  `scanCache` now both default to `false`: neither the project's `node_modules`
  nor opencode's plugin cache (`~/.cache/opencode/packages`) is scanned unless
  you explicitly set the flag to `true`. Manifest-mediated sources (Claude Code
  plugins, VS Code agent plugins) are unchanged. See the README's "Migrating
  from 1.x" section for how to restore the old behavior.
- Added the `exclude` option: package names that are skipped during discovery,
  regardless of trust tier.

### Security

- Documented the two-tier trust model in the README ("Threat model"): sources
  vouched for by host-tool manifests (Claude Code, VS Code) or installed by
  opencode itself are trusted by default; `node_modules`, user-supplied
  `extraRoots`, and manifest-less walks are untrusted. The README also states
  that enabling `mcp` or `agents` trusts every discovered package with matching
  executable config, and recommends pairing those flags with `exclude`.

[2.1.0]: https://github.com/Marinski/opencode-skill-autodiscovery/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/Marinski/opencode-skill-autodiscovery/compare/v1.4.0...v2.0.0
