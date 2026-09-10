/* A small RSS/Atom reader.

   Job feeds are simple and consistently malformed in the same ways, so a
   regex reader is both shorter and more forgiving here than pulling in an XML
   parser: several of these boards emit unescaped ampersands and bare HTML in
   <description>, which a strict parser rejects outright. */

const CDATA = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;

export function decodeEntities(str) {
  return String(str ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&"); // last, so "&amp;lt;" does not become "<"
}

function unwrap(value) {
  const m = String(value).match(CDATA);
  return m ? m[1] : decodeEntities(value);
}

/* Returns the text of the first <tag> in an item, CDATA and entities resolved. */
export function tag(item, name) {
  const m = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? unwrap(m[1]).trim() : "";
}

/* Every value for a repeated tag, e.g. <category> on RSS items. */
export function tags(item, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi");
  return [...item.matchAll(re)].map((m) => unwrap(m[1]).trim()).filter(Boolean);
}

/* Atom puts the URL in an attribute rather than in the element body. */
export function linkOf(item) {
  const plain = tag(item, "link");
  if (plain) return plain;
  const href = item.match(/<link\b[^>]*href=["']([^"']+)["']/i);
  return href ? decodeEntities(href[1]) : "";
}

export function parseFeed(xml) {
  if (!xml) return [];
  return [...String(xml).matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
}

/* Feeds date things every which way; anything Date can read is good enough,
   since all we keep is the day. */
export function feedDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
