import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { UnifiedService } from './adapter.js';
import { formatInlineCode, shortenHomePath } from './card-formatters.js';
import type { Provider, WriteContext } from './contracts.js';
import { providerBadgeColor, type ChannelCard, type ChannelCardSection } from './feishu-cards.js';
import { escapeCardMarkdown, stripCardMentions } from './feishu-card-wire.js';
import type { Authorize, FeishuPort, TrustedEnvelope } from './feishu-channel.js';
import type { FeishuSessionBinding } from './feishu-session-binding.js';
import type { NewSessionDraft, NewSessionDrafts } from './new-session-drafts.js';
import { BindingExpired } from './topic-title-sync.js';

export const MAX_NEW_SESSION_PROJECTS = 20;

export type NewSessionAction =
  | { action: 'new_help'; provider?: Provider; project?: string; initialPrompt?: string }
  | { action: 'new_provider'; t: string; r: number; p: Provider }
  | { action: 'new_pick'; t: string; r: number; i: number };

export type NewSessionOptions = {
  defaultCreateProject?: string;
  allowedProjectRoots?: readonly string[];
  enabledProviders?: readonly Provider[];
};

type Reply = (card: ChannelCard, suffix?: string) => Promise<string | void>;
type Execution = {
  scope: string;
  guard: () => Promise<void>;
  reply: Reply;
  context: WriteContext;
  bound: string | null;
};

const providerOrder: Provider[] = ['agy', 'codex', 'claude'];
const providerNames: Record<Provider, string> = { agy: 'Antigravity', codex: 'Codex', claude: 'Claude' };

function expandHomePath(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function realDirectory(path: string): string | undefined {
  const expanded = expandHomePath(path);
  if (!isAbsolute(expanded)) return;
  try {
    const real = realpathSync(expanded);
    if (statSync(real).isDirectory()) return real;
  } catch { /* stale directory */ }
}

function within(path: string, root: string): boolean {
  const tail = relative(root, path);
  return !isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`);
}

function labelsFor(paths: string[]): string[] {
  const parts = paths.map(path => path.split(sep).filter(Boolean));
  const suffix = (segments: string[], count: number) => segments.slice(-count).join('/') || '/';
  return parts.map((segments, i) => {
    for (let depth = 1; depth <= segments.length; depth++) {
      const label = suffix(segments, depth);
      if (parts.every((other, j) => i === j || suffix(other, depth) !== label)) return label;
    }
    return paths[i]!;
  });
}

function button(label: string, value: NewSessionAction): ChannelCard['actions'][number] {
  if (Buffer.byteLength(JSON.stringify(value)) > 256) throw new Error('new session callback exceeds 256 bytes');
  return { label, value };
}

export function draftCard(draft: NewSessionDraft, providers: Provider[], roots: readonly string[] = []): ChannelCard {
  const explicitProject = draft.explicit_project;
  const preview = [...stripCardMentions(draft.initial_prompt ?? '')];
  const previewText = preview.length ? `${preview.slice(0, 180).join('')}${preview.length > 180 ? '…' : ''}` : '';
  const providerActions: ChannelCard['actions'] = providers.map(p => ({
    ...button(`${p === draft.provider ? '✓ ' : ''}${providerNames[p]}`, { action: 'new_provider', t: draft.token, r: draft.revision, p }),
    type: p === draft.provider ? 'primary' as const : 'default' as const,
  }));
  const sections: ChannelCardSection[] = [
    {
      text: [
        `🤖 **第 1 步 · 选择执行 Agent**\n当前后端：${providerNames[draft.provider]}`,
        previewText ? `> 💬 首句任务：${escapeCardMarkdown(previewText)}` : '',
      ].filter(Boolean).join('\n'),
      actions: providerActions,
    },
  ];

  const home = homedir();
  const rootSet = new Set(roots);
  type IndexedProject = { proj: string; index: number };
  let explicitItem: IndexedProject | undefined;
  const subprojects: IndexedProject[] = [];
  const topWorkspaceRoots: IndexedProject[] = [];

  draft.projects.forEach((proj, index) => {
    if (explicitProject && proj === explicitProject) {
      explicitItem = { proj, index };
      return;
    }
    const hasStrictChild = draft.projects.some(other => other !== proj && within(other, proj))
      || roots.some(other => other !== proj && within(other, proj));
    const isTopRoot = rootSet.has(proj) && (
      proj === home || dirname(proj) === home || hasStrictChild
    );
    if (isTopRoot) topWorkspaceRoots.push({ proj, index });
    else subprojects.push({ proj, index });
  });

  if (explicitItem) {
    const explicitLabel = explicitItem.proj === home
      ? '~ (主目录)'
      : (basename(explicitItem.proj) || shortenHomePath(explicitItem.proj));
    sections.push({
      dividerBefore: true,
      text: `🎯 **指定目标文件夹**：\`${formatInlineCode(shortenHomePath(explicitItem.proj))}\`（点击下方按钮立即创建）`,
      actions: [{
        ...button(explicitLabel, { action: 'new_pick', t: draft.token, r: draft.revision, i: explicitItem.index }),
        type: 'primary',
      }],
    });
  }

  const grouped = new Map<string, IndexedProject[]>();
  for (const item of subprojects) {
    const nonHomeAncestors = roots
      .filter(r => r !== item.proj && r !== home && within(item.proj, r))
      .sort((a, b) => b.length - a.length);
    const groupRoot = nonHomeAncestors[0]
      ?? (dirname(item.proj) === home && rootSet.has(home) ? home : dirname(item.proj));
    const bucket = grouped.get(groupRoot) ?? [];
    bucket.push(item);
    grouped.set(groupRoot, bucket);
  }

  let groupIdx = 0;
  for (const [groupRoot, items] of grouped.entries()) {
    const relLabels = items.map(item => relative(groupRoot, item.proj).split(sep).join('/') || basename(item.proj) || item.proj);
    const uniqueRel = new Set(relLabels).size === relLabels.length;
    const finalLabels = uniqueRel ? relLabels : labelsFor(items.map(item => item.proj));
    const stepHeader = groupIdx === 0
      ? '**📂 第 2 步 · 选择会话所属文件夹**（点击即创建新话题）\n'
      : '';
    sections.push({
      dividerBefore: groupIdx === 0,
      text: `${stepHeader}📁 所属路径：\`${formatInlineCode(shortenHomePath(groupRoot))}\``,
      actions: items.map((item, idx) =>
        button(finalLabels[idx]!, { action: 'new_pick', t: draft.token, r: draft.revision, i: item.index }),
      ),
    });
    groupIdx += 1;
  }

  if (topWorkspaceRoots.length > 0) {
    const stepHeader = groupIdx === 0 && !explicitItem
      ? '**📂 第 2 步 · 选择会话所属文件夹**（点击即创建新话题）\n'
      : '';
    sections.push({
      dividerBefore: true,
      text: `${stepHeader}🏠 **直接进入顶层工作区目录**`,
      actions: topWorkspaceRoots.map(item =>
        button(
          item.proj === home ? '~ (主目录)' : shortenHomePath(item.proj),
          { action: 'new_pick', t: draft.token, r: draft.revision, i: item.index },
        ),
      ),
    });
  }

  const actions = sections.flatMap(sec => sec.actions ? [...sec.actions] : []);
  const text = sections.map(sec => sec.text).filter(Boolean).join('\n\n');
  return {
    schema: '2.0',
    title: '新建会话',
    subtitle: '第 1 步选执行 Agent · 第 2 步点文件夹开启话题',
    headerTags: [{ text: `Agent：${providerNames[draft.provider]}`, color: providerBadgeColor(draft.provider) }],
    template: 'blue',
    text,
    sections,
    actions,
  };
}

export class NewSessionFlow {
  constructor(
    private readonly drafts: NewSessionDrafts,
    private readonly service: UnifiedService,
    private readonly port: FeishuPort,
    private readonly authorize: Authorize,
    private readonly binding: FeishuSessionBinding,
    private readonly options: NewSessionOptions,
  ) {}

  private providers(): Provider[] {
    const enabled = this.options.enabledProviders;
    return providerOrder.filter(provider => {
      if (enabled) return enabled.includes(provider);
      const present = this.service.hasProvider?.(provider) as unknown;
      if (present instanceof Promise) void present.catch(() => {});
      return present === true;
    });
  }

  private roots(): string[] {
    const configured = this.options.allowedProjectRoots ?? (this.options.defaultCreateProject ? [this.options.defaultCreateProject] : []);
    return configured.flatMap(path => realDirectory(path) ?? []);
  }

  private async open(e: TrustedEnvelope, a: Extract<NewSessionAction, {action:'new_help'}>, x: Execution): Promise<unknown> {
    if (x.bound || this.port.isTopicDestination?.(e.destination)) {
      await x.reply({ title: '请在主群新建会话', text: '回到主群发送 /new，可同时附上首句任务，再选择项目目录。', actions: [] });
      return { status: 'guidance' };
    }
    const providers = this.providers();
    const roots = this.roots();
    if (!providers.length || !roots.length) {
      await x.reply({ title: '新建会话', text: '当前没有可用的后端或项目目录。', actions: [] });
      return { status: 'unavailable' };
    }
    if (a.provider && !providers.includes(a.provider)) {
      await x.reply({ title: '后端不可用', text: `当前可用后端：${providers.map(p => providerNames[p]).join('、')}。请重新发送 /new。`, actions: [] });
      return { status: 'unavailable' };
    }
    let explicitProject: string | undefined;
    if (a.project) {
      const resolved = realDirectory(a.project);
      if (!resolved || !roots.some(root => within(resolved, root))) {
        await x.reply({
          title: '目录不可用',
          template: 'orange',
          text: `目录 ${a.project} 不存在或不在允许的项目根目录内。`,
          actions: [],
        });
        return { status: 'unavailable' };
      }
      explicitProject = resolved;
    }
    const sessions = await this.service.listSessions({limit:50}).then(page => page.items, () => []);
    const visible: string[] = [];
    for (const session of sessions) {
      if (await this.authorize(e.identity, e.destination, session.sessionId)) visible.push(session.project);
    }
    const candidates = [explicitProject, this.options.defaultCreateProject, ...visible, ...roots];
    const projects = new Set<string>();
    for (const candidate of candidates) {
      const real = candidate && realDirectory(candidate);
      if (real && roots.some(root => within(real, root))) projects.add(real);
      if (projects.size >= MAX_NEW_SESSION_PROJECTS) break;
    }
    await x.guard();
    const draft = this.drafts.open(e, x.scope, a.provider ?? providers[0]!, [...projects], a.initialPrompt, explicitProject);
    const messageId = await x.reply(draftCard(draft, providers, roots), 'new-draft');
    if (messageId) this.drafts.setCardMessage(draft.token, messageId);
    return { status: 'draft' };
  }

  async handle(e: TrustedEnvelope, a: NewSessionAction, x: Execution): Promise<unknown> {
    if (a.action === 'new_help') return this.open(e, a, x);
    const unavailable = async () => {
      await x.reply({ title: '请选择新的草稿', text: '此草稿已失效、选项已更新，或项目目录已不可用。请使用卡片上的最新选项，或重新发送 /new。', actions: [] });
      return { status: 'expired' };
    };
    const draft = this.drafts.get(a.t);
    if (!draft || !e.cardMessageId || !this.drafts.matches(draft, e, x.scope)) return unavailable();
    if (!draft.card_message_id) {
      const delivered = await this.port.lookupMessageId?.(`${draft.event_id}:new-draft`);
      if (delivered !== e.cardMessageId) return unavailable();
      this.drafts.setCardMessage(a.t, delivered);
    }
    await x.guard();
    const providers = this.providers();
    const roots = this.roots();
    if (a.action === 'new_provider') {
      if (!providers.includes(a.p)) return unavailable();
      const selected = this.drafts.selectProvider(a.t, a.r, a.p, e, x.scope);
      if (!selected) return unavailable();
      const guard = async () => {
        await x.guard();
        const current = this.drafts.get(a.t);
        if (current?.revision !== selected.revision || current.state !== 'open') throw new BindingExpired('draft changed');
      };
      await this.port.update(e.destination, e.cardMessageId, draftCard(selected, providers, roots), `new-provider:${a.t}:${selected.revision}`, guard);
      return { status: 'draft' };
    }
    const createOperationId = `new-session:${a.t}`;
    const context = {...x.context, operationId:createOperationId, idempotencyKey:createOperationId};
    const claimed = this.drafts.claim(a.t, a.r, a.i, e, x.scope, context,
      (provider, project) => providers.includes(provider) && realDirectory(project) === project && roots.some(root => within(project, root)),
      () => this.binding.recordPending(createOperationId, e, null, 'session', 'interactive', true));
    if (!claimed) return unavailable();
    if (claimed.state === 'creating') {
      const guard = async () => {
        await x.guard();
        if (this.drafts.get(a.t)?.state !== 'creating') throw new BindingExpired('draft changed');
      };
      try {
        await this.binding.showDraftProgress(e,claimed,guard);
      } catch { /* The persisted creation can proceed even when the progress card cannot be updated. */ }
    }
    const operation = await this.binding.registerDraftCreate(claimed);
    return operation ?? { status: this.drafts.get(a.t)?.state, operationId:createOperationId };
  }
}
