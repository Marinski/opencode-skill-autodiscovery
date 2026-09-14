# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - Unreleased

### Added

- **Per-package `consent` option**: `consent.mcp` / `consent.agents` list
  package names whose MCP servers / agents are admitted even when the
  package is discovered as untrusted (the project's `node_modules`,
  user-supplied `extraRoots`, manifest-less walks). Refines the `mcp` /
  `agents` switches for the untrusted tier; `exclude` remains the deny side
  and wins over consent. See the README's "Per-package consent" section.

### Changed

- **Breaking:** `mcp` and `agents` no longer trust every discovered package.
  Trusted packages (Claude Code / VS Code manifests, opencode-installed
  packages) still register directly when the switch is on; an untrusted
  package's MCP servers or agents now register only when the package is
  listed under `consent.mcp` / `consent.agents`.
- **Breaking:** every package-supplied MCP server now registers with
  `enabled: false` (was `enabled: true`) — opencode no longer spawns a
  package-declared binary or connects to a package-chosen endpoint on
  discovery alone; enable it explicitly once you've reviewed it.
- **Breaking:** package-declared remote MCP servers (`streamable-http`,
  `sse`) now require `https://`; a plain `http://` URL is skipped, since it
  would ship any `headers` (including credentials) in cleartext.
- **Breaking:** agent capability clamping is stricter. Package-supplied
  `tools` grants are now always dropped (previously kept), in addition to
  the existing `permission`-block drop, and any declared `mode` other than
  `subagent` is clamped to `subagent` (previously any listed mode passed
  through). Each drop is logged naming the package and the agent.
- Skills and slash commands still register for every trust tier (read-only
  content registration is never gated), but an untrusted package now emits a
  one-line info log naming the package and its source when it registers.

### Security

- New credential-hygiene warnings for `mcp.json`: a header/env value or
  server `url` that looks credential-bearing (an `Authorization`-style
  header name, a bearer/secret-looking value, or a `user:pass@` URL) logs a
  warning naming the field, since opencode stores `config.mcp` in plaintext.
  An untrusted package's credential-bearing MCP entry is refused outright
  unless the package is listed in `consent.mcp`.
- A package stdio server's `PLUGIN_DATA` directory is no longer created at
  discovery/plan time; the `mkdir` is deferred until the server is actually
  applied to the config, so a discovered-but-unapplied server leaves no
  filesystem trace.
- Documented plaintext MCP credential storage and mitigation guidance in the
  README ("MCP credentials").

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
