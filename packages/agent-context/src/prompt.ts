export type PromptBlock = {
  readonly id: string;
  readonly content: string;
  readonly enabled?: boolean;
};

/** Renders only explicitly supplied variables; missing placeholders fail closed. */
export function renderPromptTemplate(
  template: string,
  variables: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/gu, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined) throw new Error(`Prompt variable ${name} is missing`);
    return value;
  });
}

/** Composes small Markdown prompt blocks with deterministic identity/order checks. */
export function composePromptBlocks(blocks: readonly PromptBlock[]): string {
  const seen = new Set<string>();
  return blocks
    .filter((block) => block.enabled !== false)
    .map((block) => {
      if (!block.id.trim() || seen.has(block.id)) {
        throw new Error(`Prompt block ${block.id || '<empty>'} is duplicated or empty`);
      }
      seen.add(block.id);
      const content = block.content.trim();
      if (!content) throw new Error(`Prompt block ${block.id} is empty`);
      return content;
    })
    .join('\n\n');
}
