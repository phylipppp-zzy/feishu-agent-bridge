import { randomUUID } from "node:crypto";
import type { PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

/**
 * Requests Claude is waiting on while a Feishu-driven turn runs: a tool permission, an
 * AskUserQuestion, or approval of a plan (ExitPlanMode). Each waits, as in the terminal,
 * until the person answers on its card or by replying in the topic.
 */

export type InteractionKind = "permission" | "question" | "plan";

export interface QuestionOption { label: string; description: string }
export interface AskedQuestion { question: string; header: string; options: QuestionOption[]; multiSelect: boolean }

export interface Interaction {
  nonce: string;
  sessionId: string;
  kind: InteractionKind;
  toolName: string;
  input: Record<string, unknown>;
  /** Rules that would stop Claude asking again in this session ("allow for this session"). */
  suggestions: PermissionUpdate[];
  allowAlways: boolean;
  /** Prompt sentence and explanation Claude Code supplies for the request. */
  title: string | null;
  reason: string | null;
  questions: AskedQuestion[];
  answers: string[];
  cardMessageId: string | null;
  resolve: (result: PermissionResult) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** AskUserQuestion's input: 1–4 questions with 2–4 options each, possibly multi-select. */
export function askedQuestions(input: Record<string, unknown>): AskedQuestion[] {
  const questions = Array.isArray(input.questions) ? input.questions.filter(isRecord) : [];
  return questions.map((question) => ({
    question: typeof question.question === "string" ? question.question : "",
    header: typeof question.header === "string" ? question.header : "",
    multiSelect: question.multiSelect === true,
    options: (Array.isArray(question.options) ? question.options.filter(isRecord) : []).map((option) => ({
      label: typeof option.label === "string" ? option.label : "",
      description: typeof option.description === "string" ? option.description : "",
    })).filter((option) => option.label),
  })).filter((question) => question.question);
}

/** Interprets a typed answer: option numbers (several for multi-select, "1,3"), else the text itself. */
export function typedAnswer(question: AskedQuestion, text: string): string {
  const numbers = text.split(/[,，、\s]+/).filter(Boolean);
  if (numbers.length && numbers.every((value) => /^[1-9]\d*$/.test(value))) {
    const picked = numbers.map((value) => question.options[Number(value) - 1]?.label);
    if (picked.every(Boolean) && (question.multiSelect || picked.length === 1)) return picked.join(", ");
  }
  return text.trim();
}

/** The AskUserQuestion result: answers keyed by the question text, as Claude Code expects. */
export function questionResult(interaction: Interaction): PermissionResult {
  const answers: Record<string, string> = {};
  interaction.questions.forEach((question, index) => {
    const answer = interaction.answers[index];
    if (answer) answers[question.question] = answer;
  });
  return { behavior: "allow", updatedInput: { ...interaction.input, answers } };
}

/** Approves a plan and switches the session to the chosen mode, like the terminal's plan prompt. */
export function planResult(interaction: Interaction, mode: "acceptEdits" | "default"): PermissionResult {
  return { behavior: "allow", updatedInput: interaction.input, updatedPermissions: [{ type: "setMode", mode, destination: "session" }] };
}

export class InteractionRegistry {
  private readonly items = new Map<string, Interaction>();

  add(fields: Omit<Interaction, "nonce" | "answers" | "cardMessageId">): Interaction {
    const interaction: Interaction = { ...fields, nonce: randomUUID(), answers: [], cardMessageId: null };
    this.items.set(interaction.nonce, interaction);
    return interaction;
  }

  get(nonce: string): Interaction | null { return this.items.get(nonce) ?? null; }

  /** The oldest open request of a session; a reply in the topic answers it. */
  forSession(sessionId: string): Interaction | null {
    for (const interaction of this.items.values()) if (interaction.sessionId === sessionId) return interaction;
    return null;
  }

  has(sessionId: string): boolean { return this.forSession(sessionId) !== null; }

  /** Settles a request once; later clicks on its card find nothing. */
  settle(nonce: string, result: PermissionResult): Interaction | null {
    const interaction = this.items.get(nonce);
    if (!interaction) return null;
    this.items.delete(nonce);
    interaction.resolve(result);
    return interaction;
  }

  /** Denies every open request of a session, for example when its run ends or the bridge stops. */
  cancelSession(sessionId: string, message: string): Interaction[] {
    const cancelled = [...this.items.values()].filter((interaction) => interaction.sessionId === sessionId);
    for (const interaction of cancelled) this.settle(interaction.nonce, { behavior: "deny", message });
    return cancelled;
  }

  sessions(): string[] { return [...new Set([...this.items.values()].map((interaction) => interaction.sessionId))]; }
}
