# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - Unreleased

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

[2.0.0]: https://github.com/Marinski/opencode-skill-autodiscovery/compare/v1.4.0...v2.0.0
