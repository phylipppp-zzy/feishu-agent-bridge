/** Card work that may take longer than a card callback may: Feishu waits three seconds for its answer. */
import type { CardActionOutcome, CardDefinition, FeishuPort } from "./types.js";

/**
 * Answers a tap at once with a "working on it" card in place of the tapped one, finishes the
 * work afterwards and puts its result on the same message. A tap that times out still runs its
 * work, so a person who taps again could otherwise start a second session or a second cancel;
 * here a repeated tap while the first is running only gets a notice.
 */
export class SlowCardActions {
  private readonly running = new Set<string>();

  constructor(
    private readonly feishu: Pick<FeishuPort, "updateCard">,
    private readonly onError: (key: string, error: unknown) => void,
    /** The result waits at least this long, so it is not overwritten by the callback's own card arriving later. */
    private readonly settleMs = 1_000,
  ) {}

  run(messageId: string, key: string, pending: CardDefinition, work: () => Promise<CardDefinition>, failed: (error: unknown) => CardDefinition): CardActionOutcome {
    if (this.running.has(key)) return { delivery: "toast", text: "正在处理，请稍候。", level: "info" };
    this.running.add(key);
    const tappedAt = Date.now();
    void (async () => {
      let card: CardDefinition;
      try { card = await work(); } catch (error) { this.onError(key, error); card = failed(error); }
      const wait = tappedAt + this.settleMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      await this.feishu.updateCard(messageId, card);
    })().catch((error) => this.onError(key, error)).finally(() => this.running.delete(key));
    return { delivery: "replace", card: pending };
  }

  /** For tests and shutdown: whether work for `key` is still running. */
  busy(key: string): boolean { return this.running.has(key); }
}
