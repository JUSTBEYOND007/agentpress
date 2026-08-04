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
  const description = sanitizeSkillDescription(metadata.description);
  const instructions = (match[2] ?? '').trim();
  if (!instructions) throw new Error('Skill instructions are required');
  if (!description) throw new Error('Skill description is required');
  if (allowedTools.length > 32) throw new Error('Skill can allow at most 32 tools');
  if (description.length > 1_024) throw new Error('Skill description exceeds 1024 characters');
  if (resources.some((resource) => !isSafeSkillResourcePath(resource))) {
    throw new Error('Skill resource path is invalid');
  }
  return {
    id,
    version,
    description,
    allowedTools: [...new Set(allowedTools)].sort(),
    instructions,
    ...(metadata.license ? { license: metadata.license } : {}),
    ...(metadata.compatibility ? { compatibility: metadata.compatibility } : {}),
    ...(resources.length > 0 ? { resources } : {}),
    ...(metadata['disable-model-invocation'] === true ? { disableModelInvocation: true } : {}),
    ...(metadata.hidden === true ? { hidden: true } : {}),
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

export type SkillInvocationSelection = {
  readonly skill: SkillDefinition;
  readonly source: 'explicit' | 'model';
};

export function selectSkillsForInvocation(
  skills: readonly SkillDefinition[],
  input: {
    readonly explicitSkillIds?: readonly string[];
    readonly modelSelectedSkillIds?: readonly string[];
    readonly limit?: number;
  },
): readonly SkillInvocationSelection[] {
  const limit = input.limit ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
    throw new RangeError('A Run can select between 1 and 8 Skills');
  }
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const selected = new Map<string, SkillInvocationSelection>();
  for (const id of input.explicitSkillIds ?? []) {
    const skill = byId.get(id);
    if (!skill) throw new Error(`Explicit Skill ${id} is unavailable`);
    selected.set(id, { skill, source: 'explicit' });
  }
  for (const id of input.modelSelectedSkillIds ?? []) {
    const skill = byId.get(id);
    if (!skill || skill.disableModelInvocation || skill.hidden || selected.has(id)) continue;
    selected.set(id, { skill, source: 'model' });
  }
  if (selected.size > limit) throw new Error(`A Run can select at most ${String(limit)} Skills`);
  return [...selected.values()].sort(
    (left, right) =>
      (left.source === right.source ? 0 : left.source === 'explicit' ? -1 : 1) ||
      left.skill.id.localeCompare(right.skill.id),
  );
}

export type SkillResourceDocument = {
  readonly path: string;
  readonly content: string;
  readonly fileType: 'file' | 'directory' | 'symlink' | 'hardlink' | 'other';
};

export function loadStaticSkillResources(
  skill: SkillDefinition,
  documents: readonly SkillResourceDocument[],
  options: { readonly maxFileBytes?: number; readonly maxTotalBytes?: number } = {},
): readonly { readonly path: string; readonly content: string; readonly contentHash: string }[] {
  const maxFileBytes = options.maxFileBytes ?? 256_000;
  const maxTotalBytes = options.maxTotalBytes ?? 1_000_000;
  if (maxFileBytes < 1 || maxTotalBytes < maxFileBytes) {
    throw new RangeError('Skill resource byte limits are invalid');
  }
  const declared = skill.resources ?? [];
  const byPath = new Map<string, SkillResourceDocument>();
  for (const document of documents) {
    if (byPath.has(document.path)) throw new Error(`Duplicate Skill resource ${document.path}`);
    byPath.set(document.path, document);
  }
  let totalBytes = 0;
  return declared.map((path) => {
    if (!isSafeSkillResourcePath(path)) throw new Error(`Skill resource ${path} is unsafe`);
    const document = byPath.get(path);
    if (!document) throw new Error(`Skill resource ${path} is missing`);
    if (document.fileType !== 'file') {
      throw new Error(`Skill resource ${path} must be a regular file`);
    }
    const bytes = Buffer.byteLength(document.content, 'utf8');
    if (bytes > maxFileBytes) throw new Error(`Skill resource ${path} exceeds the file limit`);
    totalBytes += bytes;
    if (totalBytes > maxTotalBytes) throw new Error('Skill resources exceed the total limit');
    return {
      path,
      content: document.content,
      contentHash: createHash('sha256').update(document.content).digest('hex'),
    };
  });
}

export function sanitizeSkillDescription(value: string): string {
  let sanitized = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    sanitized += code < 32 || code === 127 ? ' ' : character;
  }
  return sanitized.replace(/\s+/gu, ' ').trim();
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
  readonly hidden?: unknown;
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
    /^[a-z0-9][a-z0-9._-]{0,159}$/iu.test(identity) &&
    isAllowedToolsValue(item.allowedTools ?? item['allowed-tools']) &&
    (item.resources === undefined || isStringArray(item.resources)) &&
    (item['disable-model-invocation'] === undefined ||
      typeof item['disable-model-invocation'] === 'boolean') &&
    (item.hidden === undefined || typeof item.hidden === 'boolean')
  );
}

function normalizeAllowedTools(metadata: SkillMetadata): readonly string[] {
  const value = metadata.allowedTools ?? metadata['allowed-tools'] ?? [];
  if (Array.isArray(value)) {
    return value
      .filter((tool): tool is string => typeof tool === 'string')
      .map((tool) => tool.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string')
    return value
      .split(/\s+/u)
      .map((tool) => tool.trim())
      .filter(Boolean);
  return [];
}

function normalizeResources(metadata: SkillMetadata): readonly string[] {
  return isStringArray(metadata.resources) ? [...new Set(metadata.resources)].sort() : [];
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
