import type {PlatformInputBlock} from './adapter.js';

function truncate(title: string, limit: number): string {
  const characters = [...title];
  return characters.length <= limit ? title : characters.slice(0, limit - 1).join('').trimEnd() + '…';
}

export function deriveTitleFromInputBlocks(blocks: readonly PlatformInputBlock[]): string | null {
  let filename = '';
  for (const block of blocks) {
    if (block.type === 'artifact') {
      filename ||= block.name.replace(/\s+/gu, ' ').trim();
      continue;
    }
    const source = block.text;
    for (const line of source.split(/\r\n?|\n/u)) {
      const title = line.replace(/\s+/gu, ' ').trim();
      if (title) return truncate(title, 48);
    }
  }
  return filename ? truncate(filename, 48) : null;
}

export function isGenericSessionTitle(title: string | null | undefined): boolean {
  const value = title?.trim();
  return !value || value === '未命名会话' || /^(?:Claude|Codex|Antigravity) 会话 · [0-9a-f]{8}$/iu.test(value);
}

export function normalizeTopicTitle(title: string): string {
  return truncate(title.replace(/\s+/gu, ' ').trim() || '未命名会话', 60);
}
