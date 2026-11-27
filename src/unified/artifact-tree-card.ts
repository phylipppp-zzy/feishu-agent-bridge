import type { DirectoryListing } from '../claude/deliver.js';
import type { Artifact } from './contracts.js';
import type { ChannelCard } from './feishu-cards.js';

export function formatHumanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildProjectFilesCard(listing: DirectoryListing): ChannelCard {
  let text: string;
  if (listing.kind === 'error') {
    text = listing.message;
  } else if (listing.kind === 'file') {
    text = `${listing.entry.name} (${formatHumanSize(listing.entry.size)})`;
  } else {
    const sorted = [...listing.entries].sort((x, y) =>
      x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind === 'dir' ? -1 : 1,
    );
    const treeLines = sorted.map((x, idx) => {
      const branch = idx === sorted.length - 1 ? '└──' : '├──';
      return x.kind === 'dir'
        ? `${branch} ${x.name}/`
        : `${branch} ${x.name} (${formatHumanSize(x.size)})`;
    });
    const body = treeLines.length ? treeLines.join('\n') : '(空目录)';
    const tip = listing.total > 0 ? '\n💡 发送 /file <相对路径> 可直接把文件发到飞书，/ls -a 查看隐藏文件' : '';
    text = `📁 ${listing.path}\n${body}\n显示 ${listing.entries.length}/${listing.total} 项，隐藏 ${listing.hidden} 项${tip}`;
  }
  return { title: '项目目录', format: 'plain', text, actions: [] };
}

export interface ArtifactTreeCardOptions {
  projectDir?: string;
  cursor?: string;
  sessionId?: string;
}

export interface ArtifactTreeCardResult {
  card: ChannelCard;
  items: Artifact[];
  nextCursor: string | null;
}

export function buildArtifactTreeCard(
  rawItems: readonly Artifact[],
  options: ArtifactTreeCardOptions = {},
): ArtifactTreeCardResult {
  const deduped: Artifact[] = [];
  const seenVersions = new Set<string>();
  for (const item of rawItems) {
    const pathKey = item.relativePath || item.name;
    const dedupKey = `${pathKey}\0${item.contentVersion}`;
    if (seenVersions.has(dedupKey)) continue;
    seenVersions.add(dedupKey);
    deduped.push(item);
  }
  const normalizeRel = (item: Artifact): string =>
    (item.relativePath || item.name).replace(/\\/g, '/').replace(/^\.\//, '');
  const splitRel = (item: Artifact): { dir: string; filename: string; pathKey: string } => {
    const rel = normalizeRel(item);
    const slash = rel.lastIndexOf('/');
    return {
      dir: slash >= 0 ? rel.slice(0, slash) || '.' : '.',
      filename: slash >= 0 ? rel.slice(slash + 1) || item.name : rel,
      pathKey: item.relativePath || item.name,
    };
  };
  const pathCounts = new Map<string, number>();
  const byDir = new Map<string, Artifact[]>();
  for (const item of deduped) {
    const { dir, pathKey } = splitRel(item);
    pathCounts.set(pathKey, (pathCounts.get(pathKey) ?? 0) + 1);
    const list = byDir.get(dir) ?? [];
    list.push(item);
    byDir.set(dir, list);
  }
  const sortedDirs = [...byDir.keys()].sort((x, y) => (x === '.' ? -1 : y === '.' ? 1 : x.localeCompare(y)));
  const ordered = sortedDirs.flatMap((dir) => byDir.get(dir)!);

  const PAGE_SIZE = 8;
  const total = ordered.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const parsedCursor = options.cursor !== undefined ? Number(options.cursor) : 0;
  const rawOffset = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
  const maxOffset = total === 0 ? 0 : Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE;
  const offset = Math.min(rawOffset, maxOffset);
  const pageItems = ordered.slice(offset, offset + PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const prevCursor = offset > 0 ? String(Math.max(0, offset - PAGE_SIZE)) : null;
  const nextCursor = offset + PAGE_SIZE < total ? String(offset + PAGE_SIZE) : null;

  const truncateLabel = (name: string, max: number): string => {
    const chars = [...name];
    return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : name;
  };

  const projectDir = options.projectDir || '未知';
  const headerLines = [`默认目录：${projectDir}`];
  const actions: ChannelCard['actions'] = [];
  let text: string;
  if (total === 0) {
    text = `默认目录：${projectDir}\n\n暂无可下载文件。\n提示：如需浏览项目目录，可发送 /ls 或 /ls <子目录>。`;
  } else {
    if (totalPages > 1) headerLines.push(`共 ${total} 个文件（第 ${currentPage}/${totalPages} 页）`);
    const pageGroups: Array<{ dir: string; entries: Array<{ item: Artifact; num: number; filename: string; pathKey: string }> }> = [];
    for (const [idx, item] of pageItems.entries()) {
      const { dir, filename, pathKey } = splitRel(item);
      const num = idx + 1;
      let group = pageGroups.find((g) => g.dir === dir);
      if (!group) {
        group = { dir, entries: [] };
        pageGroups.push(group);
      }
      group.entries.push({ item, num, filename, pathKey });
      const needsHash = (pathCounts.get(pathKey) ?? 0) > 1;
      const label = needsHash
        ? `${num}. ${truncateLabel(filename, 14)} (${item.contentVersion.slice(0, 6)})`
        : `${num}. ${truncateLabel(filename, 20)}`;
      actions.push({ label, value: { action: 'file', artifactId: item.artifactId, contentVersion: item.contentVersion } });
    }
    if (prevCursor !== null) {
      actions.push({ label: '上一页', value: { action: 'artifacts', ...(options.sessionId ? { sessionId: options.sessionId } : {}), cursor: prevCursor } });
    }
    if (nextCursor !== null) {
      actions.push({ label: '下一页', value: { action: 'artifacts', ...(options.sessionId ? { sessionId: options.sessionId } : {}), cursor: nextCursor } });
    }
    const treeLines: string[] = [];
    for (const group of pageGroups) {
      treeLines.push(`📁 ${group.dir === '.' ? './' : `${group.dir}/`}`);
      for (const [entryIdx, entry] of group.entries.entries()) {
        const branch = entryIdx === group.entries.length - 1 ? '└──' : '├──';
        const hashSuffix = (pathCounts.get(entry.pathKey) ?? 0) > 1 ? ` · ${entry.item.contentVersion.slice(0, 6)}` : '';
        treeLines.push(`${branch} ${entry.num}. ${entry.filename} (${formatHumanSize(entry.item.size)})${hashSuffix}`);
      }
    }
    text = `${headerLines.join('\n')}\n\n${treeLines.join('\n')}`;
  }
  return {
    card: { title: '文件', format: 'plain', text, actions },
    items: pageItems,
    nextCursor,
  };
}
