import type { CardDefinition, FeishuPort } from "../types.js";

export interface BacklogEntry {
  /** Caller must only aggregate ended turns; active and approval turns remain visible individually. */
  status: "ended";
  id: string;
  title: string;
  body: string;
  /** Optional source session label or link, included in both summary and full export. */
  source?: string;
}

export interface BacklogSummary {
  card: CardDefinition;
  markdown: string;
  fileName: string;
  count: number;
}

export interface BacklogDeliveryRecord {
  cardMessageId: string;
  markdownMessageId: string;
  count: number;
}

/** Build one concise overview card and a complete Markdown export, without a fixed item cap. */
export function buildBacklogSummary(entries: readonly BacklogEntry[], generatedAt = new Date()): BacklogSummary | null {
  if (!entries.length) return null;
  if (entries.some((entry) => entry.status !== "ended")) throw new Error("Only ended turns may be included in a backlog summary");
  const items = entries.map((entry, index) => ({ ...entry, ordinal: index + 1 }));
  const fullSections = items.map((entry) => [
    `## ${entry.ordinal}. ${entry.title}`,
    `ID: ${entry.id}`,
    ...(entry.source ? [`来源：${entry.source}`] : []),
    "",
    entry.body,
  ].join("\n"));
  const markdown = `# 待处理积压（${items.length} 项）\n\n生成时间：${generatedAt.toISOString()}\n\n${fullSections.join("\n\n---\n\n")}\n`;
  return {
    card: {
      schema: "2.0",
      config: { wide_screen_mode: true },
      header: { template: "orange", title: { tag: "plain_text", content: `待处理积压 · ${items.length} 项` } },
      body: { elements: [
        { tag: "markdown", content: `当前积压 **${items.length} 项**。每项的标题、来源和完整正文均已收录在随附的 Markdown 文件中。` },
      ] },
    },
    markdown,
    fileName: `backlog-${generatedAt.toISOString().replace(/[:.]/g, "-")}.md`,
    count: items.length,
  };
}

/**
 * Deliver the summary as one card and its complete Markdown as a file in the card's topic.
 * Empty backlog is a no-op. No retry is performed here: callers can safely retry only after
 * checking persisted delivery state, avoiding duplicate full-text attachments.
 */
export async function deliverBacklogSummary(
  entries: readonly BacklogEntry[],
  port: Pick<FeishuPort, "replyCard" | "replyFile">,
  rootMessageId: string,
  generatedAt = new Date(),
  options: {
    cardMessageId?: string;
    markdownMessageId?: string;
    cardUuid?: string;
    markdownUuid?: string;
    /** Persist the card ID before attempting the full-text attachment, so a retry can resume. */
    onCardMessage?: (messageId: string) => void | Promise<void>;
  } = {},
): Promise<BacklogDeliveryRecord | null> {
  const summary = buildBacklogSummary(entries, generatedAt);
  if (!summary) return null;
  const cardMessageId = options.cardMessageId ?? await port.replyCard(rootMessageId, summary.card, options.cardUuid ? { uuid: options.cardUuid } : undefined);
  if (!options.cardMessageId) await options.onCardMessage?.(cardMessageId);
  const markdownMessageId = options.markdownMessageId ?? await port.replyFile(rootMessageId, summary.fileName, Buffer.from(summary.markdown, "utf8"), options.markdownUuid ? { uuid: options.markdownUuid } : undefined);
  return { cardMessageId, markdownMessageId, count: summary.count };
}
