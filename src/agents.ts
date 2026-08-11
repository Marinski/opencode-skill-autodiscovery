import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";
import type { PluginPackage } from "./discovery.js";

// opencode's config.agent shape (subset of the SDK's AgentConfig). Permission
// blocks are deliberately never carried over from packages.
export type AgentConfig = {
  model?: string;
  temperature?: number;
  top_p?: number;
  prompt?: string;
  tools?: Record<string, boolean>;
  disable?: boolean;
  description?: string;
  mode?: "subagent" | "primary" | "all";
  color?: string;
  maxSteps?: number;
};

// Reverse-DNS namespace this plugin (and opencode, by convention) owns for
// client-specific manifest data and extension directories (Agent Plugins 5.6/8).
const OPENCODE_NS = "dev.opencode";

const MODES = new Set(["subagent", "primary", "all"]);

// opencode accepts a `#RRGGBB` literal or one of its theme tokens; anything else
// makes the whole config fail to load. Claude Code agent frontmatter, however,
// uses bare CSS colour names, so translate the ones it emits and drop the rest.
const COLOR_TOKENS = new Set([
  "primary",
  "secondary",
  "accent",
  "success",
  "warning",
  "error",
  "info",
]);

// CSS named colours where one exists, Tailwind's 500 shade for the names CSS
// does not define (amber, slate, rose). Covers every bare name observed across
// shipped Claude Code / Agent Plugins agent frontmatter.
const COLOR_NAMES: Record<string, string> = {
  red: "#FF0000",
  orange: "#FFA500",
  amber: "#F59E0B",
  gold: "#FFD700",
  yellow: "#FFFF00",
  olive: "#808000",
  lime: "#00FF00",
  green: "#008000",
  teal: "#008080",
  turquoise: "#40E0D0",
  aqua: "#00FFFF",
  cyan: "#00FFFF",
  "neon-cyan": "#00FFFF",
  "neon-green": "#39FF14",
  blue: "#0000FF",
  navy: "#000080",
  "metallic-blue": "#4682B4",
  indigo: "#4B0082",
  violet: "#EE82EE",
  purple: "#800080",
  magenta: "#FF00FF",
  fuchsia: "#FF00FF",
  pink: "#FFC0CB",
  rose: "#F43F5E",
  crimson: "#DC143C",
  maroon: "#800000",
  brown: "#A52A2A",
  slate: "#64748B",
  silver: "#C0C0C0",
  white: "#FFFFFF",
  gray: "#808080",
  grey: "#808080",
  black: "#000000",
};

// Returns a value opencode's config schema will accept, or undefined when the
// colour is unusable. Never let an unrecognised value through: a single bad
// colour rejects the entire merged config.
function normalizeColor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  // `#RGB` shorthand is valid CSS but not accepted by opencode; expand it.
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return `#${value.slice(1).split("").map((c) => c + c).join("")}`;
  }
  const lower = value.toLowerCase();
  if (COLOR_TOKENS.has(lower)) return lower;
  const mapped = COLOR_NAMES[lower];
  if (mapped) return mapped;
  log(`dropping unsupported agent color ${JSON.stringify(value)}`);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// Converts a raw, package-supplied agent object into an opencode AgentConfig.
// `permission` blocks are dropped (too powerful to inherit by default) and
// unknown/mistyped keys are ignored. Returns null when nothing usable is left.
function toAgentConfig(raw: unknown): AgentConfig | null {
  const src = asRecord(raw);
  if (!src) return null;
  const agent: AgentConfig = {};

  const stringValue = (key: "model" | "prompt" | "description" | "color"): string | undefined =>
    typeof src[key] === "string" ? (src[key] as string) : undefined;
  const numberValue = (key: "temperature" | "top_p" | "maxSteps"): number | undefined =>
    typeof src[key] === "number" && Number.isFinite(src[key] as number)
      ? (src[key] as number)
      : undefined;

  const model = stringValue("model");
  const prompt = stringValue("prompt");
  const description = stringValue("description");
  const color = normalizeColor(stringValue("color"));
  const temperature = numberValue("temperature");
  const topP = numberValue("top_p");
  const maxSteps = numberValue("maxSteps");
  if (model) agent.model = model;
  if (prompt) agent.prompt = prompt;
  if (description) agent.description = description;
  if (color) agent.color = color;
  if (temperature !== undefined) agent.temperature = temperature;
  if (topP !== undefined) agent.top_p = topP;
  if (maxSteps !== undefined) agent.maxSteps = maxSteps;
  if (typeof src.disable === "boolean") agent.disable = src.disable;
  if (typeof src.mode === "string" && MODES.has(src.mode)) {
    agent.mode = src.mode as AgentConfig["mode"];
  }
  const tools = asRecord(src.tools);
  if (tools) {
    const filtered: Record<string, boolean> = {};
    for (const [name, value] of Object.entries(tools)) {
      if (typeof value === "boolean") filtered[name] = value;
    }
    agent.tools = filtered;
  }
  if (src.permission !== undefined) {
    log("dropping permission block from a package-supplied agent: too powerful to inherit");
  }
  if (!agent.description && !agent.prompt) return null;
  return agent;
}

// Discovers agents contributed by a package, in order:
//   1. plugin.json `extensions["dev.opencode"].agents` (Agent Plugins 5.6)
//   2. a `dev.opencode/agents/<name>.json` extension directory (Agent Plugins 8.2)
//   3. a legacy Claude Code plugin shim: `.claude-plugin/plugin.json` `agents`
//      plus `agents/<name>/AGENTS.md` when no systemPrompt is declared.
// Returns a stable, de-duplicated list keyed by agent name.
export function readAgents(
  pkg: PluginPackage,
): Array<{ name: string; agent: AgentConfig }> {
  const out = new Map<string, AgentConfig>();

  const manifest = asRecord(readJson(join(pkg.root, "plugin.json")));
  const extensions = asRecord(manifest?.extensions);
  const opencodeExt = asRecord(extensions?.[OPENCODE_NS]);
  const manifestAgents = asRecord(opencodeExt?.agents);
  if (manifestAgents) {
    for (const [name, raw] of Object.entries(manifestAgents)) {
      if (out.has(name)) continue;
      const agent = toAgentConfig(raw);
      if (agent) out.set(name, agent);
    }
  }

  const extDir = join(pkg.root, OPENCODE_NS, "agents");
  let extEntries: string[] = [];
  try {
    extEntries = readdirSync(extDir);
  } catch {
    extEntries = [];
  }
  for (const entry of extEntries) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    if (out.has(name)) continue;
    const agent = toAgentConfig(readJson(join(extDir, entry)));
    if (agent) out.set(name, agent);
  }

  const claudeManifest = asRecord(
    readJson(join(pkg.root, ".claude-plugin", "plugin.json")),
  );
  const claudeAgents = asRecord(claudeManifest?.agents);
  if (claudeAgents) {
    for (const [name, raw] of Object.entries(claudeAgents)) {
      if (out.has(name)) continue;
      const src = asRecord(raw);
      if (!src || typeof src.description !== "string") continue;
      const agent: AgentConfig = { description: src.description };
      if (typeof src.systemPrompt === "string" && src.systemPrompt) {
        agent.prompt = src.systemPrompt;
      } else {
        try {
          agent.prompt = readFileSync(
            join(pkg.root, "agents", name, "AGENTS.md"),
            "utf8",
          );
        } catch {
          // No prompt file; the description alone is enough to register.
        }
      }
      if (typeof src.model === "string") agent.model = src.model;
      if (agent.prompt || agent.description) out.set(name, agent);
    }
  }

  // Legacy flat agent files: agents/<name>.md, plus bare <name>.md files in
  // the package root (the current agency-agents layout: engineering/*.md).
  // Both ship one markdown file per specialist without declaring an `agents`
  // field in a .claude-plugin manifest.
  const flatRoots = [join(pkg.root, "agents"), pkg.root];
  for (const flatAgentsDir of flatRoots) {
    const isRoot = flatAgentsDir === pkg.root;
    let flatEntries: string[];
    try {
      flatEntries = readdirSync(flatAgentsDir);
    } catch {
      continue;
    }
    for (const entry of flatEntries) {
      if (!entry.endsWith(".md")) continue;
      const name = entry.slice(0, -".md".length);
      if (out.has(name)) continue;
      let content: string;
      try {
        content = readFileSync(join(flatAgentsDir, entry), "utf8");
      } catch {
        continue;
      }
      // Bare .md files in the package root may be docs (README.md); only treat
      // them as agents when they carry a frontmatter block.
      if (isRoot && !/^---\s*\n/.test(content)) continue;
      const { description, color, body } = parseAgentMarkdown(content);
      if (!description && !body) continue;
      const agent: AgentConfig = {};
      if (description) agent.description = description;
      if (color) agent.color = color;
      if (body) agent.prompt = body;
      out.set(name, agent);
    }
  }

  return [...out.entries()].map(([name, agent]) => ({ name, agent }));
}

// Extracts frontmatter fields (description, color) and the markdown body from
// a flat agent file. The body becomes the agent's system prompt.
function parseAgentMarkdown(content: string): {
  description?: string;
  color?: string;
  body: string;
} {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!m) return { body: content };
  const field = (key: string): string | undefined => {
    const fm = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(m[1]);
    return fm ? fm[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  const description = field("description");
  const color = normalizeColor(field("color"));
  const body = content.slice(m[0].length).trim();
  return { description: description || undefined, color, body };
}
