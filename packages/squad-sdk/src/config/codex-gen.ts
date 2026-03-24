/**
 * Codex CLI agent config generator.
 *
 * Generates `.codex/agents/*.toml` files so that `codex --agent squad --yolo`
 * works out of the box. Codex discovers agents from `.codex/agents/` and can
 * spawn them as subagents within a session.
 *
 * @see https://developers.openai.com/codex/subagents
 * @module config/codex-gen
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface CodexAgentSpec {
  /** Agent name (kebab-case, matches squad member name) */
  name: string;
  /** Human-readable role title */
  role: string;
  /** Short description of when to use this agent */
  description?: string;
  /** Optional model override (e.g. "gpt-4.1", "gpt-5.4-mini") */
  model?: string;
  /** sandbox_mode: "read-only" | "workspace-write" | "full-network" */
  sandboxMode?: string;
}

export interface CodexGeneratorOptions {
  /** Absolute path to project root */
  projectRoot: string;
  /** Project / team name */
  teamName: string;
  /** Squad member agents */
  agents: CodexAgentSpec[];
  /** If true, overwrite existing files. Default: false */
  force?: boolean;
}

export interface CodexGeneratedFile {
  /** Relative path from projectRoot */
  relPath: string;
  /** File content */
  content: string;
}

// ============================================================================
// TOML generators
// ============================================================================

/**
 * Escape a string for use inside a TOML basic string (double-quoted).
 */
function tomlEscapeBasic(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Wrap text in a TOML multi-line basic string.
 */
function tomlMultiline(s: string): string {
  return `"""\n${s}\n"""`;
}

/**
 * Generate the coordinator `squad.toml` for Codex CLI.
 *
 * The coordinator's `developer_instructions` explains its role and lists
 * the available subagents so Codex knows when to spawn them.
 */
export function generateCoordinatorToml(options: {
  teamName: string;
  agents: CodexAgentSpec[];
}): string {
  const { teamName, agents } = options;

  const agentList = agents
    .map(a => `  - ${a.name} (${a.role})${a.description ? ': ' + a.description : ''}`)
    .join('\n');

  const memberSection = agents.length > 0
    ? `\nAvailable subagents — spawn these by name for specialised work:\n${agentList}\n`
    : '';

  const instructions = `\
You are **Squad (Coordinator)** — the orchestrator for the ${teamName} AI team.

## Your Role
- Receive tasks from the user, break them down, and delegate to specialists.
- Maximise parallel work: launch multiple subagents simultaneously when tasks are independent.
- Do NOT generate code, designs, or domain artefacts yourself — spawn the right agent.
- Assemble results from agents and return a consolidated response to the user.
- Use the \`--yolo\` flag so agents can act without per-tool confirmation.

## Workflow
1. Read the task and identify parallel work streams.
2. Spawn the appropriate subagent(s) from your team (see below).
3. Wait for all results, then summarise for the user.
4. Store decisions in \`.squad/decisions.md\` via Scribe when relevant.
${memberSection}
## Team State
- Team roster: \`.squad/team.md\`
- Routing rules: \`.squad/routing.md\`
- Decisions log: \`.squad/decisions.md\`
- Agent charters: \`.squad/agents/<name>/charter.md\`
`;

  const lines: string[] = [
    `name = "squad"`,
    `description = "Squad coordinator for ${tomlEscapeBasic(teamName)} — orchestrates your AI team and spawns specialists."`,
    `developer_instructions = ${tomlMultiline(instructions)}`,
  ];

  return lines.join('\n') + '\n';
}

/**
 * Generate a per-agent `.toml` file for a Squad member.
 *
 * The agent's `developer_instructions` references its charter on disk so
 * Codex picks up the full role definition when it spawns the subagent.
 */
export function generateAgentToml(agent: CodexAgentSpec): string {
  const charterPath = `.squad/agents/${agent.name}/charter.md`;

  const instructions = `\
You are **${agent.name}** — ${agent.role}.

${agent.description ? agent.description + '\n\n' : ''}\
Your full charter, boundaries, and working style are defined in \`${charterPath}\`.
Read your charter at the start of every session to orient yourself.

## Rules
- Stay in your lane: only perform work that falls within your charter.
- Write outputs to the correct locations (code, docs, tests — as per charter).
- Report decisions and blockers back to the Squad coordinator.
- Update \`.squad/agents/${agent.name}/history.md\` with a brief log of what you did.
`;

  const lines: string[] = [
    `name = "${tomlEscapeBasic(agent.name)}"`,
    `description = "${tomlEscapeBasic(agent.description ?? agent.role)}"`,
    `developer_instructions = ${tomlMultiline(instructions)}`,
  ];

  if (agent.model) {
    lines.push(`model = "${tomlEscapeBasic(agent.model)}"`);
  }
  if (agent.sandboxMode) {
    lines.push(`sandbox_mode = "${tomlEscapeBasic(agent.sandboxMode)}"`);
  }

  return lines.join('\n') + '\n';
}

// ============================================================================
// File plan builder
// ============================================================================

/**
 * Build the full list of `.codex/agents/` files to generate.
 */
export function buildCodexFilePlan(options: {
  teamName: string;
  agents: CodexAgentSpec[];
}): CodexGeneratedFile[] {
  const files: CodexGeneratedFile[] = [];

  files.push({
    relPath: '.codex/agents/squad.toml',
    content: generateCoordinatorToml(options),
  });

  for (const agent of options.agents) {
    files.push({
      relPath: `.codex/agents/${agent.name}.toml`,
      content: generateAgentToml(agent),
    });
  }

  return files;
}

// ============================================================================
// Disk writer
// ============================================================================

/**
 * Write `.codex/agents/*.toml` files to disk.
 *
 * By default skips files that already exist (respects `force` flag).
 * Returns the list of relative paths that were written.
 */
export function writeCodexAgentFiles(options: CodexGeneratorOptions): string[] {
  const { projectRoot, teamName, agents, force = false } = options;
  const written: string[] = [];

  const files = buildCodexFilePlan({ teamName, agents });

  for (const file of files) {
    const absPath = join(projectRoot, file.relPath);

    if (existsSync(absPath) && !force) {
      continue;
    }

    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, file.content, 'utf-8');
    written.push(file.relPath);
  }

  return written;
}

// ============================================================================
// Team.md reader — used by upgrade to discover existing agents
// ============================================================================

/**
 * Parse agent names and roles from `.squad/team.md` Members table.
 * Returns an empty array if team.md does not exist or has no Members section.
 */
export function parseTeamMdAgents(projectRoot: string): CodexAgentSpec[] {
  const teamMdPath = join(projectRoot, '.squad', 'team.md');
  if (!existsSync(teamMdPath)) return [];

  const content = readFileSync(teamMdPath, 'utf-8');
  const agents: CodexAgentSpec[] = [];

  // Find ## Members section
  const membersMatch = content.match(/##\s+Members[\s\S]*?(?=\n##|\s*$)/);
  if (!membersMatch) return agents;

  const section = membersMatch[0];

  // Parse markdown table rows: | Name | Role | Charter | Status |
  const rowRe = /^\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/gm;
  let match: RegExpExecArray | null;
  let firstRow = true;

  while ((match = rowRe.exec(section)) !== null) {
    const name = (match[1] ?? '').trim();
    const role = (match[2] ?? '').trim();

    // Skip header and separator rows
    if (name === 'Name' || name.startsWith('---') || name.startsWith(':---')) {
      firstRow = false;
      continue;
    }
    if (firstRow) { firstRow = false; continue; }

    // Skip @copilot / special entries
    if (name.startsWith('@') || name.toLowerCase() === 'name') continue;

    agents.push({ name: name.toLowerCase().replace(/\s+/g, '-'), role });
  }

  return agents;
}

/**
 * Discover existing `.codex/agents/<name>.toml` files (excluding squad.toml).
 * Useful for upgrade to know which agent files already exist.
 */
export function listExistingCodexAgentFiles(projectRoot: string): string[] {
  const dir = join(projectRoot, '.codex', 'agents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.toml') && f !== 'squad.toml')
    .map(f => f.replace(/\.toml$/, ''));
}
