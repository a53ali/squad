/**
 * Claude Code agent config generator.
 *
 * Generates `.claude/agents/*.md` files so that `claude --agent squad --yolo`
 * works out of the box. Claude Code discovers subagents from `.claude/agents/`
 * and spawns them for specialised tasks.
 *
 * File format: Markdown with YAML frontmatter.
 *   - `name`        — unique identifier (required)
 *   - `description` — when Claude should delegate to this agent (required)
 *   - `tools`       — comma-separated list of allowed tools (optional)
 *   - `model`       — sonnet | opus | haiku | inherit (optional)
 *
 * @see https://docs.anthropic.com/en/docs/claude-code/sub-agents
 * @module config/claude-gen
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';

// ============================================================================
// Types
// ============================================================================

export interface ClaudeAgentSpec {
  /** Agent name (kebab-case, matches squad member name) */
  name: string;
  /** Human-readable role title */
  role: string;
  /** Short description of when Claude should delegate to this agent */
  description?: string;
  /**
   * Comma-separated tools the agent may use.
   * Defaults to all tools when omitted.
   * Examples: "Read, Write, Edit, Bash, Glob, Grep"
   */
  tools?: string;
  /** Model: "sonnet" | "opus" | "haiku" | full model ID | "inherit" */
  model?: string;
}

export interface ClaudeGeneratorOptions {
  /** Absolute path to project root */
  projectRoot: string;
  /** Project / team name */
  teamName: string;
  /** Squad member agents */
  agents: ClaudeAgentSpec[];
  /** If true, overwrite existing files. Default: false */
  force?: boolean;
}

export interface ClaudeGeneratedFile {
  /** Relative path from projectRoot */
  relPath: string;
  /** File content */
  content: string;
}

// ============================================================================
// Markdown generators
// ============================================================================

/**
 * Build a YAML frontmatter block from key-value pairs,
 * omitting keys whose values are undefined or empty.
 */
function buildFrontmatter(fields: Record<string, string | undefined>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---`;
}

/**
 * Generate the coordinator `squad.md` for Claude Code.
 *
 * The body becomes the system prompt loaded when `claude --agent squad` runs.
 */
export function generateClaudeCoordinatorMd(options: {
  teamName: string;
  agents: ClaudeAgentSpec[];
  model?: string;
}): string {
  const { teamName, agents, model } = options;

  const agentList = agents
    .map(a => `  - **${a.name}** (${a.role})${a.description ? ': ' + a.description : ''}`)
    .join('\n');

  const memberSection = agents.length > 0
    ? `\n## Available Subagents\n\nDelegate to these specialists by name — Claude Code will spawn them automatically:\n\n${agentList}\n`
    : '';

  const body = `\
You are **Squad (Coordinator)** — the orchestrator for the ${teamName} AI team.

## Your Role
- Receive tasks from the user, break them down, and delegate to specialists.
- Maximise parallel work: spawn multiple subagents simultaneously when tasks are independent.
- Do NOT generate code, designs, or domain artefacts yourself — spawn the right agent.
- Assemble results and return a consolidated response to the user.
- Store decisions in \`.squad/decisions.md\` via Scribe when relevant.
${memberSection}
## Workflow
1. Read the task and identify parallel work streams.
2. Delegate to the appropriate subagent(s) from your team (see above).
3. Wait for all results, then summarise for the user.

## Team State
- Team roster: \`.squad/team.md\`
- Routing rules: \`.squad/routing.md\`
- Decisions log: \`.squad/decisions.md\`
- Agent charters: \`.squad/agents/<name>/charter.md\`
`;

  const frontmatter = buildFrontmatter({
    name: 'squad',
    description: `Squad coordinator for ${teamName} — orchestrates your AI team and delegates to specialists.`,
    ...(model ? { model } : {}),
  });

  return `${frontmatter}\n\n${body}`;
}

/**
 * Generate a per-agent `.md` file for a Squad member.
 *
 * The body is the system prompt that Claude Code injects when the subagent runs.
 */
export function generateClaudeAgentMd(agent: ClaudeAgentSpec): string {
  const charterPath = `.squad/agents/${agent.name}/charter.md`;

  const body = `\
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

  const frontmatter = buildFrontmatter({
    name: agent.name,
    description: agent.description ?? agent.role,
    ...(agent.tools ? { tools: agent.tools } : {}),
    ...(agent.model ? { model: agent.model } : {}),
  });

  return `${frontmatter}\n\n${body}`;
}

// ============================================================================
// File plan builder
// ============================================================================

/**
 * Build the full list of `.claude/agents/` files to generate.
 */
export function buildClaudeFilePlan(options: {
  teamName: string;
  agents: ClaudeAgentSpec[];
  model?: string;
}): ClaudeGeneratedFile[] {
  const files: ClaudeGeneratedFile[] = [];

  files.push({
    relPath: '.claude/agents/squad.md',
    content: generateClaudeCoordinatorMd(options),
  });

  for (const agent of options.agents) {
    files.push({
      relPath: `.claude/agents/${agent.name}.md`,
      content: generateClaudeAgentMd(agent),
    });
  }

  return files;
}

// ============================================================================
// Disk writer
// ============================================================================

/**
 * Write `.claude/agents/*.md` files to disk.
 *
 * By default skips files that already exist (respects `force` flag).
 * Returns the list of relative paths that were written.
 */
export function writeClaudeAgentFiles(options: ClaudeGeneratorOptions): string[] {
  const { projectRoot, teamName, agents, force = false } = options;
  const written: string[] = [];

  const files = buildClaudeFilePlan({ teamName, agents });

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
// Team.md reader — reuses logic from codex-gen for upgrade
// ============================================================================

/**
 * Parse agent names and roles from `.squad/team.md` Members table.
 * Returns an empty array if team.md does not exist or has no Members section.
 */
export function parseTeamMdAgentsForClaude(projectRoot: string): ClaudeAgentSpec[] {
  const teamMdPath = join(projectRoot, '.squad', 'team.md');
  if (!existsSync(teamMdPath)) return [];

  const content = readFileSync(teamMdPath, 'utf-8');
  const agents: ClaudeAgentSpec[] = [];

  const membersMatch = content.match(/##\s+Members[\s\S]*?(?=\n##|\s*$)/);
  if (!membersMatch) return agents;

  const section = membersMatch[0];
  const rowRe = /^\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/gm;
  let match: RegExpExecArray | null;
  let firstRow = true;

  while ((match = rowRe.exec(section)) !== null) {
    const name = (match[1] ?? '').trim();
    const role = (match[2] ?? '').trim();

    if (name === 'Name' || name.startsWith('---') || name.startsWith(':---')) {
      firstRow = false;
      continue;
    }
    if (firstRow) { firstRow = false; continue; }
    if (name.startsWith('@') || name.toLowerCase() === 'name') continue;

    agents.push({ name: name.toLowerCase().replace(/\s+/g, '-'), role });
  }

  return agents;
}

/**
 * Discover existing `.claude/agents/<name>.md` files (excluding squad.md).
 */
export function listExistingClaudeAgentFiles(projectRoot: string): string[] {
  const dir = join(projectRoot, '.claude', 'agents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== 'squad.md')
    .map(f => f.replace(/\.md$/, ''));
}
