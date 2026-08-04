import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import type { SkillDefinition } from './contracts.js';

export function loadSkill(markdown: string): SkillDefinition {
  if (Buffer.byteLength(markdown, 'utf8') > 64_000) throw new Error('Skill exceeds 64000 bytes');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u.exec(markdown);
  if (!match) throw new Error('Skill requires YAML frontmatter and instructions');
  const metadata: unknown = parse(match[1] ?? '');
  if (!isMetadata(metadata)) throw new Error('Skill metadata is invalid');
  const id = metadata.id ?? metadata.name;
  if (!id) throw new Error('Skill id is required');
  const version = typeof metadata.version === 'string' ? metadata.version : '1.0.0';
  const allowedTools = normalizeAllowedTools(metadata);
  const resources = normalizeResources(metadata);
  const instructions = (match[2] ?? '').trim();
  if (!instructions) throw new Error('Skill instructions are required');
  if (allowedTools.length > 32) throw new Error('Skill can allow at most 32 tools');
  if (metadata.description.length > 1_024) throw new Error('Skill description exceeds 1024 characters');
  if (resources.some((resource) => !isSafeSkillResourcePath(resource))) {
    throw new Error('Skill resource path is invalid');
  }
  return {
    id,
    version,
    description: metadata.description,
    allowedTools: [...new Set(allowedTools)].sort(),
    instructions,
    ...(metadata.license ? { license: metadata.license } : {}),
    ...(metadata.compatibility ? { compatibility: metadata.compatibility } : {}),
    ...(resources.length > 0 ? { resources } : {}),
    ...(metadata['disable-model-invocation'] === true ? { disableModelInvocation: true } : {}),
  };
}

export type SkillDocument = {
  readonly path: string;
  readonly markdown: string;
  readonly source: 'builtin' | 'workspace' | 'user';
  readonly explicit?: boolean;
};

/** Discovers already-read SKILL.md documents with deterministic precedence. */
export function discoverSkills(documents: readonly SkillDocument[]): readonly SkillDefinition[] {
  const selected = new Map<string, { skill: SkillDefinition; document: SkillDocument }>();
  for (const document of [...documents].sort(compareSkillDocuments)) {
    if (!isSkillMarkdownPath(document.path)) continue;
    const skill = loadSkill(document.markdown);
    const current = selected.get(skill.id);
    if (!current || compareSkillDocuments(document, current.document) < 0) {
      selected.set(skill.id, { skill, document });
    }
  }
  return [...selected.values()]
    .sort((left, right) => left.skill.id.localeCompare(right.skill.id))
    .map(({ skill }) => skill);
}

export function isSafeSkillResourcePath(resource: string): boolean {
  if (!resource || resource.startsWith('/') || resource.includes('\\')) return false;
  const parts = resource.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
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

type SkillMetadata = {
  readonly id?: string;
  readonly name?: string;
  readonly version?: string;
  readonly description: string;
  readonly allowedTools?: unknown;
  readonly ['allowed-tools']?: unknown;
  readonly resources?: unknown;
  readonly ['disable-model-invocation']?: unknown;
  readonly license?: string;
  readonly compatibility?: string;
};

function isMetadata(value: unknown): value is SkillMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as SkillMetadata;
  const identity = item.id ?? item.name;
  return (
    (typeof item.id === 'string' || typeof item.name === 'string') &&
    (item.version === undefined || typeof item.version === 'string') &&
    typeof item.description === 'string' &&
    typeof identity === 'string' &&
    identity === identity.trim() &&
    identity.length > 0 &&
    !identity.includes('/') &&
    isAllowedToolsValue(item.allowedTools ?? item['allowed-tools']) &&
    (item.resources === undefined || isStringArray(item.resources)) &&
    (item['disable-model-invocation'] === undefined || typeof item['disable-model-invocation'] === 'boolean')
  );
}

function normalizeAllowedTools(metadata: SkillMetadata): readonly string[] {
  const value = metadata.allowedTools ?? metadata['allowed-tools'] ?? [];
  if (Array.isArray(value)) return value.filter((tool): tool is string => typeof tool === 'string');
  if (typeof value === 'string') return value.split(/\s+/u).filter(Boolean);
  return [];
}

function normalizeResources(metadata: SkillMetadata): readonly string[] {
  return isStringArray(metadata.resources) ? [...new Set(metadata.resources)] : [];
}

function isAllowedToolsValue(value: unknown): boolean {
  return value === undefined || typeof value === 'string' || isStringArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isSkillMarkdownPath(path: string): boolean {
  return path.split('/').at(-1) === 'SKILL.md' && !path.split('/').some((part) => part === '..');
}

function compareSkillDocuments(left: SkillDocument, right: SkillDocument): number {
  const sourceRank = { user: 0, workspace: 1, builtin: 2 } as const;
  const leftRank = (left.explicit ? -1 : 0) + sourceRank[left.source] * 2;
  const rightRank = (right.explicit ? -1 : 0) + sourceRank[right.source] * 2;
  return leftRank - rightRank || left.path.localeCompare(right.path);
}
