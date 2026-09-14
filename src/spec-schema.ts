import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { pluginSchema100 } from "./schemas/plugin-schema-1.0.0.js";
import { mcpSchema100 } from "./schemas/mcp-schema-1.0.0.js";

// Validates plugin.json and mcp.json documents (and individual MCP server
// entries) against the *published* Agent Plugins JSON schemas, vendored
// verbatim under ./schemas — never against a hand-copied field list.
// dodopayments/dodo-agent-plugin#13 found their own hand-authored .mcp.json
// carried an `enabled` key the real schema's closed union
// (`additionalProperties: false`) rejects — this project's prior
// STDIO_KEYS/HTTP_KEYS-based checks already happened to list the right keys
// for that specific case, but the general risk they carry is real: any field
// the schema forbids but nobody thought to add to a hand-copied key set
// silently passes. One concrete case this switch does newly catch: the real
// schema's `env` sub-schema forbids declaring `PLUGIN_ROOT`/`PLUGIN_DATA`
// (property name validation on the whole object), where the prior hand-
// rolled check only dropped those two keys and kept the rest of the entry —
// see discovery.test.js's "reserved PLUGIN_ROOT/PLUGIN_DATA env keys" tests
// for both that behavior change and the version-fallback path preserving
// the old (looser) handling for any schema version not vendored here.
//
// Only version 1.0.0 is vendored (it's the only version published today).
// PLUGIN_SCHEMA/MCP_SCHEMA in schema.ts still accept any 1.x.x for the
// $schema gate itself; callers apply these stricter validators only when the
// declared version exactly matches what's vendored here, and fall back to
// their pre-existing lenient checks otherwise — a future 1.1.0 manifest is
// never rejected just because this plugin hasn't vendored its schema yet.
export const PLUGIN_SCHEMA_1_0_0_ID = pluginSchema100.$id;
export const MCP_SCHEMA_1_0_0_ID = mcpSchema100.$id;

const ajv = new Ajv2020({ allErrors: true, strict: true });

const validatePluginDoc = ajv.compile(pluginSchema100);
const validateMcpDoc = ajv.compile(mcpSchema100);
// A standalone schema reusing mcp.schema.json's $defs, rather than a pointer
// into the already-compiled document: self-contained, so it validates one
// server entry on its own without depending on cross-schema $id resolution.
const validateMcpEntry = ajv.compile({
  $defs: mcpSchema100.$defs,
  $ref: "#/$defs/server",
});

export type ValidationResult = { valid: true } | { valid: false; errors: string[] };

function formatError(e: ErrorObject): string {
  const path = e.instancePath || "(document root)";
  return `${path} ${e.message ?? "is invalid"}`;
}

function toResult(validate: ValidateFunction, ok: boolean): ValidationResult {
  if (ok) return { valid: true };
  // A oneOf mismatch (e.g. a server entry matching none of
  // stdio/streamable-http/sse) reports one error per failed branch, which is
  // accurate but repetitive; dedupe rather than lose any distinct message.
  const errors = [...new Set((validate.errors ?? []).map(formatError))];
  return { valid: false, errors };
}

// Validates a plugin.json document against Agent Plugins 1.0.0's
// plugin.schema.json (root manifest shape: name, $schema, extensions, etc.).
export function validatePluginManifest(manifest: unknown): ValidationResult {
  return toResult(validatePluginDoc, validatePluginDoc(manifest));
}

// Validates an mcp.json document's top-level shape ($schema + mcpServers
// container) against Agent Plugins 1.0.0's mcp.schema.json. Does not validate
// individual server entries — use validateMcpServerEntry for those, so one
// malformed server never fails the whole document (the existing per-entry
// fail-closed philosophy this module preserves, not just formalizes).
export function validateMcpDocumentShape(doc: unknown): ValidationResult {
  return toResult(validateMcpDoc, validateMcpDoc(doc));
}

// Validates one mcpServers[name] entry against the spec's server union
// (stdio | streamable-http | sse). A failure here means only that one
// server is skipped by the caller — never the rest of the package.
export function validateMcpServerEntry(entry: unknown): ValidationResult {
  return toResult(validateMcpEntry, validateMcpEntry(entry));
}
