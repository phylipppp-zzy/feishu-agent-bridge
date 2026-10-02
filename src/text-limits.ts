/**
 * Size limits for text sent to Feishu. Limits apply to the bytes of the request body, so text is
 * measured as it is serialized into JSON (UTF-8, with escapes) and cut only between characters.
 */

/** Bytes `text` takes inside a JSON string: UTF-8 plus escapes for quotes, backslashes and control characters. */
export function serializedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

/**
 * Bytes `text` takes in a Feishu card message: the card is JSON text that is itself sent as a JSON
 * string field, so quotes, backslashes and line breaks are escaped twice.
 */
export function cardContentBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(text)), "utf8") - 4;
}

type Measure = (text: string) => number;

/** End index rounded down so that it does not split a surrogate pair. */
function endBoundary(text: string, index: number): number {
  const code = text.charCodeAt(index - 1);
  return index > 0 && index < text.length && code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

/** Start index rounded up so that it does not split a surrogate pair. */
function startBoundary(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return index > 0 && index < text.length && code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}

/** The largest `units` in [0, length] for which `fits(units)` holds; `fits` must be monotonic. */
function largest(length: number, fits: (units: number) => boolean): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle; else high = middle - 1;
  }
  return low;
}

/** The longest start of `text` whose serialized size is at most `maxBytes`. */
export function headByBytes(text: string, maxBytes: number, measure: Measure = serializedBytes): string {
  if (maxBytes <= 0) return "";
  const units = largest(text.length, (count) => measure(text.slice(0, endBoundary(text, count))) <= maxBytes);
  return text.slice(0, endBoundary(text, units));
}

/** The longest end of `text` whose serialized size is at most `maxBytes`. */
export function tailByBytes(text: string, maxBytes: number, measure: Measure = serializedBytes): string {
  if (maxBytes <= 0) return "";
  const units = largest(text.length, (count) => measure(text.slice(startBoundary(text, text.length - count))) <= maxBytes);
  return text.slice(startBoundary(text, text.length - units));
}

/**
 * `text` if it fits in `maxBytes` once serialized, else its start and end around `notice`, the
 * whole still within `maxBytes`. Start and end never overlap: together they are smaller than the text.
 */
export function boundedPreview(text: string, maxBytes: number, notice: string, measure: Measure = serializedBytes): string {
  if (measure(text) <= maxBytes) return text;
  const separator = `\n\n${notice}\n\n`;
  const budget = Math.max(0, maxBytes - measure(separator));
  const head = headByBytes(text, Math.floor(budget * 0.75), measure);
  const tail = tailByBytes(text, budget - measure(head), measure);
  return head + separator + tail;
}
