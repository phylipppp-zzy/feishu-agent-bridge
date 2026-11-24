export type ShellOperator = '&&' | '||' | '|' | ';' | '<' | '>' | '>>' | '>&' | '<&';
type Token = { word: string; glob?: true } | { operator: ShellOperator };
export interface ShellCommand {
  words: string[];
  redirects: { path: string; write: boolean }[];
  globs?: number[];
  next?: ShellOperator;
}

// Parse the static subset used for ordinary commands. Dynamic words can change
// both the program and its operands, so their effects require manual review.
function tokenize(source: string, allowTestGlob: boolean): Token[] | null {
  if (!source.trim() || source.length > 32_768 || source.includes('\0')) return null;
  const tokens: Token[] = [];
  let word = '';
  let inWord = false;
  let quotedWord = false;
  let glob = false;
  let quote: '"' | "'" | null = null;
  const flush = () => {
    if (inWord) tokens.push(glob ? { word, glob: true } : { word });
    word = '';
    inWord = false;
    quotedWord = false;
    glob = false;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    const next = source[i + 1];
    if (char === quote) {
      quote = null;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      if (next === undefined) return null;
      if (quote && !['"', '$', '`', '\\', '\n'].includes(next)) {
        word += char;
        continue;
      }
      i++;
      if (next !== '\n') {
        word += next;
        inWord = true;
        quotedWord = true;
      }
      continue;
    }
    if (quote) {
      if (quote === '"' && (char === '$' || char === '`')) return null;
      word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
      quotedWord = true;
      continue;
    }
    if (char === '#' && !inWord) {
      while (i + 1 < source.length && source[i + 1] !== '\n') i++;
      continue;
    }
    if (char === '*' && allowTestGlob) glob = true;
    else if ('$`(){}*?['.includes(char)) return null;
    if ('|&;<>\n'.includes(char)) {
      if ((char === '<' || char === '>') && inWord && !quotedWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      }
      flush();
      const pair = char + (next ?? '');
      if (pair === '<<' || pair === '<>' || pair === '>|' || pair === '|&') return null;
      if (['&&', '||', '>>', '>&', '<&'].includes(pair)) {
        tokens.push({ operator: pair as ShellOperator });
        i++;
      } else if (char === '&') return null;
      else if (char === '\n') {
        const last = tokens.at(-1);
        if (last && ('word' in last || !['&&', '||', '|', ';'].includes(last.operator))) {
          tokens.push({ operator: ';' });
        }
      } else tokens.push({ operator: char as ShellOperator });
    } else if (char === ' ' || char === '\t') flush();
    else {
      word += char;
      inWord = true;
    }
    if (tokens.length > 1_024) return null;
  }
  if (quote) return null;
  flush();
  return tokens;
}

export function parseShellCommands(source: string, allowTestGlob = false): ShellCommand[] | null {
  const tokens = tokenize(source, allowTestGlob);
  if (!tokens) return null;
  const commands: ShellCommand[] = [];
  let current: ShellCommand = { words: [], redirects: [] };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if ('word' in token) {
      if (token.glob) (current.globs ??= []).push(current.words.length);
      current.words.push(token.word);
    } else if (['<', '>', '>>', '>&', '<&'].includes(token.operator)) {
      const operand = tokens[++i];
      if (!operand || !('word' in operand) || !operand.word || operand.glob) return null;
      if (token.operator.endsWith('&')) {
        if (!/^(?:[0-9]+|-)$/.test(operand.word)) return null;
      } else current.redirects.push({ path: operand.word, write: token.operator !== '<' });
    } else {
      if (!current.words.length && !current.redirects.length) return null;
      current.next = token.operator;
      commands.push(current);
      current = { words: [], redirects: [] };
    }
  }
  if (current.words.length || current.redirects.length) commands.push(current);
  else if (commands.at(-1)?.next !== ';') return null;
  return commands.length ? commands : null;
}
