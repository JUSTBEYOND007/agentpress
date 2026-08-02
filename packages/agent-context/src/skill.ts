import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import type { SkillDefinition } from './contracts.js';

export function loadSkill(markdown: string): SkillDefinition {
  if (Buffer.byteLength(markdown, 'utf8') > 64_000) throw new Error('Skill exceeds 64000 bytes');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u.exec(markdown);
  if (!match) throw new Error('Skill requires YAML frontmatter and instructions');
  const metadata: unknown = parse(match[1] ?? '');
  if (!isMetadata(metadata)) throw new Error('Skill metadata is invalid');
  const instructions = (match[2] ?? '').trim();
  if (!instructions) throw new Error('Skill instructions are required');
  if (metadata.allowedTools.length > 32) throw new Error('Skill can allow at most 32 tools');
  return {
    id: metadata.id,
    version: metadata.version,
    description: metadata.description,
    allowedTools: [...new Set(metadata.allowedTools)].sort(),
    instructions,
  };
}

export function pinSkills(skills: readonly SkillDefinition[]): Readonly<Record<string, string>> {
  return Object.fromEntries(
    skills.map((skill) => [
      skill.id,
      `${skill.version}:${createHash('sha256').update(JSON.stringify(skill)).digest('hex')}`,
    ]),
  );
}

export function narrowSkillTools(
  policyTools: ReadonlySet<string>,
  skill: SkillDefinition,
): ReadonlySet<string> {
  return new Set(skill.allowedTools.filter((tool) => policyTools.has(tool)));
}

function isMetadata(
  value: unknown,
): value is { id: string; version: string; description: string; allowedTools: string[] } {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.version === 'string' &&
    typeof item.description === 'string' &&
    Array.isArray(item.allowedTools) &&
    item.allowedTools.every((tool) => typeof tool === 'string')
  );
}
