/** Feishu card building blocks shared by the Codex and Claude bridges. */
import type { CardDefinition } from "./types.js";

let uiVersion: 1 | 2 = 1;
let elementSequence = 0;

export function configureCardUi(version: 1 | 2): void { uiVersion = version; }
export function cardUiVersion(): 1 | 2 { return uiVersion; }
/** A fresh element id; Card 2.0 requires ids to be unique within one card. */
export function nextElementId(prefix: string): string { return `${prefix}_${++elementSequence}`; }

export function plain(content: string): Record<string, string> { return { tag: "plain_text", content }; }
export function markdown(content: string): Record<string, string> { return { tag: "markdown", content }; }
export function note(content: string): Record<string, unknown> {
  return uiVersion === 2 ? markdown(content) : { tag: "note", elements: [plain(content)] };
}
export function button(label: string, action: string, type: "default" | "primary" | "danger" = "default", extra: Record<string, unknown> = {}): Record<string, unknown> {
  const value = { action, ...extra };
  return uiVersion === 2
    ? { tag: "button", element_id: nextElementId("btn"), text: plain(label), type, behaviors: [{ type: "callback", value }] }
    : { tag: "button", text: plain(label), type, value };
}
export function actionRow(actions: Record<string, unknown>[]): Record<string, unknown> {
  if (uiVersion === 1) return { tag: "action", layout: "flow", actions };
  // "flow" wraps buttons onto new lines on narrow screens instead of squeezing them until their labels turn into "…".
  return {
    tag: "column_set", flex_mode: "flow", horizontal_spacing: "8px", horizontal_align: "left",
    columns: actions.map((action) => ({ tag: "column", width: "auto", elements: [action] })),
  };
}
export function card(title: string, template: string, elements: Record<string, unknown>[]): CardDefinition {
  const common = { config: { wide_screen_mode: true, enable_forward: false, update_multi: true }, header: { template, title: plain(title) } };
  return uiVersion === 2 ? { schema: "2.0", ...common, body: { elements } } : { ...common, elements };
}

/** The longest text a card input may accept. */
export const INPUT_MAX_LENGTH = 1_000;

export interface FormButton { label: string; action: string; type?: "default" | "primary" | "danger"; extra?: Record<string, unknown>; }
export function inputForm(options: {
  formName: string; inputName: string; elementId: string; placeholder: string; maxLength: number;
  required?: boolean; multiline?: boolean; rows?: number; buttons: FormButton[];
}): Record<string, unknown>[] {
  // Feishu rejects the whole card when an input allows more than 1000 characters (error 11310).
  const maxLength = Math.min(options.maxLength, INPUT_MAX_LENGTH);
  const input: Record<string, unknown> = uiVersion === 2 ? {
    tag: "input", element_id: options.elementId, name: options.inputName, required: options.required ?? false,
    placeholder: plain(options.placeholder), max_length: maxLength, width: "fill",
    ...(options.multiline ? { input_type: "multiline_text", rows: options.rows ?? 4, auto_resize: true, max_rows: 8 } : {}),
  } : {
    tag: "input", name: options.inputName, required: options.required ?? false, placeholder: plain(options.placeholder),
    max_length: maxLength, ...(options.multiline ? { input_type: "multiline_text", multiline: true, rows: options.rows ?? 4 } : {}),
  };
  const submitButtons = options.buttons.map((item, index) => {
    const built = button(item.label, item.action, item.type ?? "default", item.extra ?? {});
    return uiVersion === 2
      ? { ...built, name: `${options.formName}_b${index + 1}`, form_action_type: "submit" }
      : { ...built, name: `${options.formName}_b${index + 1}`, action_type: "form_submit" };
  });
  if (uiVersion === 1) return [input, actionRow(submitButtons)];
  return [{
    tag: "form", element_id: `${options.formName}_id`, name: options.formName, direction: "vertical", vertical_spacing: "8px",
    elements: [input, actionRow(submitButtons)],
  }];
}
export function safeMarkdown(value: string): string { return value.replace(/[\\`*_{}\[\]()#+.!|>-]/g, "\\$&"); }
export function shorten(value: string, limit = 100): string { return [...value.replace(/\s+/g, " ").trim()].slice(0, limit).join(""); }

/** A fenced code block that cannot be closed early by the text inside it. */
export function codeBlock(text: string, limit: number): string {
  const clipped = text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text;
  return `\`\`\`\n${clipped.replace(/\`\`\`/g, "ˋˋˋ")}\n\`\`\``;
}

/** Times shown in cards: the service may run in another time zone than the person reading them. */
export function displayTime(ms: number): string {
  return `${new Date(ms).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })}（北京时间）`;
}
