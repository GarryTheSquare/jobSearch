/* A very small YAML reader and writer, for one job only: the front matter of
   the Obsidian control panel note.

   Obsidian and the Meta Bind plugin write that block, so the only shapes this
   has to survive are the ones they emit — block maps, block and flow
   sequences, quoted and plain scalars. Anything richer (anchors, multi-line
   scalars, maps nested inside sequences) throws instead of guessing, so a bad
   hand-edit is reported in Obsidian rather than quietly rewriting config.json.

   It exists so the panel needs no dependency: `npm install` for this project
   still only pulls Playwright. */

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/* Splits a note into its front matter and the rest. A note without front
   matter is not an error — it simply has no settings yet. */
export function splitFrontMatter(text) {
  const match = text.match(FRONT_MATTER);
  if (!match) return { data: {}, body: text, hasFrontMatter: false };
  return { data: parseYaml(match[1]), body: text.slice(match[0].length), hasFrontMatter: true };
}

export function withFrontMatter(data, body) {
  return `---\n${stringifyYaml(data)}---\n${body.startsWith("\n") ? body : "\n" + body}`;
}

/* ---------- reading ---------- */

export function parseYaml(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    lines.push({ indent: raw.match(/^[ \t]*/)[0].length, text: trimmed, no: index + 1 });
  });
  if (!lines.length) return {};
  const cursor = { i: 0 };
  const value = parseBlock(lines, cursor, lines[0].indent);
  if (cursor.i < lines.length) throw new Error(`line ${lines[cursor.i].no}: unexpected indentation`);
  return value;
}

function parseBlock(lines, cursor, indent) {
  return lines[cursor.i].text.startsWith("-") ? parseSequence(lines, cursor, indent) : parseMap(lines, cursor, indent);
}

function parseSequence(lines, cursor, indent) {
  const out = [];
  while (cursor.i < lines.length && lines[cursor.i].indent === indent && lines[cursor.i].text.startsWith("-")) {
    const line = lines[cursor.i++];
    const rest = line.text.slice(1).trim();
    out.push(rest === "" ? nested(lines, cursor, indent) : parseScalar(rest, line.no));
  }
  return out;
}

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:]+):(?:[ \t]+(.*))?$/;

function parseMap(lines, cursor, indent) {
  const out = {};
  while (cursor.i < lines.length && lines[cursor.i].indent === indent) {
    const line = lines[cursor.i];
    const match = line.text.match(KEY);
    if (!match) throw new Error(`line ${line.no}: expected "key: value", got ${JSON.stringify(line.text)}`);
    cursor.i++;
    const key = String(parseScalar(match[1].trim(), line.no));
    const rest = (match[2] ?? "").trim();
    out[key] = rest === "" ? nested(lines, cursor, indent) : parseScalar(rest, line.no);
  }
  return out;
}

/* What follows a "key:" with nothing after it: an indented block, a sequence
   written back at the key's own indentation (how Obsidian writes lists), or
   nothing at all — an empty value, which is null. */
function nested(lines, cursor, indent) {
  const next = lines[cursor.i];
  if (!next) return null;
  if (next.indent > indent) return parseBlock(lines, cursor, next.indent);
  if (next.indent === indent && next.text.startsWith("-")) return parseSequence(lines, cursor, indent);
  return null;
}

function parseScalar(raw, lineNo) {
  const text = raw.trim();
  if (text === "" || text === "~" || /^null$/i.test(text)) return null;
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  if (text.startsWith('"')) return unquoteDouble(text, lineNo);
  if (text.startsWith("'")) return unquoteSingle(text, lineNo);
  if (text.startsWith("[")) return parseFlowSequence(text, lineNo);
  if (text === "{}") return {};
  if (text.startsWith("{")) throw new Error(`line ${lineNo}: inline objects are not supported here`);
  if (/^-?\d+$/.test(text) || /^-?(?:\d+\.\d*|\.\d+)$/.test(text)) return Number(text);
  return text.replace(/[ \t]+#.*$/, "").trim(); // a plain scalar may carry a trailing comment
}

function unquoteDouble(text, lineNo) {
  if (!/^"(?:[^"\\]|\\.)*"$/.test(text)) throw new Error(`line ${lineNo}: unterminated double-quoted string`);
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(1, -1).replace(/\\(.)/g, "$1");
  }
}

function unquoteSingle(text, lineNo) {
  if (!/^'(?:[^']|'')*'$/.test(text)) throw new Error(`line ${lineNo}: unterminated single-quoted string`);
  return text.slice(1, -1).replace(/''/g, "'");
}

function parseFlowSequence(text, lineNo) {
  if (!text.endsWith("]")) throw new Error(`line ${lineNo}: unterminated [ ... ]`);
  const inner = text.slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let current = "";
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (const ch of inner) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items.map((item) => parseScalar(item, lineNo));
}

/* ---------- writing ---------- */

export function stringifyYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  let out = "";
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (Array.isArray(item)) {
      out += item.length
        ? `${pad}${formatKey(key)}:\n` + item.map((entry) => `${pad}  - ${formatScalar(entry)}\n`).join("")
        : `${pad}${formatKey(key)}: []\n`;
    } else if (item && typeof item === "object") {
      const nestedText = stringifyYaml(item, indent + 2);
      out += nestedText ? `${pad}${formatKey(key)}:\n${nestedText}` : `${pad}${formatKey(key)}: {}\n`;
    } else {
      const scalar = formatScalar(item);
      out += `${pad}${formatKey(key)}:${scalar === "" ? "" : " " + scalar}\n`;
    }
  }
  return out;
}

const PLAIN = /^[A-Za-z_][A-Za-z0-9_ .:/,()+&-]*$/;

function formatKey(key) {
  return PLAIN.test(key) && !key.includes(": ") ? key : JSON.stringify(key);
}

/* Quotes anything that would read back as something other than the string it
   is — an empty value, a number, a boolean, or a line YAML would choke on. */
function formatScalar(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value);
  const needsQuotes =
    text === "" ||
    text !== text.trim() ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(text) ||
    /: |[ \t]#/.test(text) ||
    /^(true|false|null|~|yes|no|on|off)$/i.test(text) ||
    /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text);
  return needsQuotes ? JSON.stringify(text) : text;
}
