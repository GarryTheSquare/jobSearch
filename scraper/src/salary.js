/* Salary strings, normalised to a yearly and an hourly figure.

   The boards write pay every way there is: "€ 2.493 - € 2.569 per maand"
   (Indeed), "$50,000 - $70,000 per jaar", "GBP 28 - GBP 34 per uur",
   "€ 16,21 per uur", "$35,3k- $52k", "Tot € 4.778 per maand". This reads the
   amount(s), the currency as written and the period, and converts:

     yearly  = amount × (12 a month, 52 a week, 260 a day, 52 × hours an hour)
     hourly  = yearly ÷ (52 × hours a week)

   Hours a week are the job's own when it states a full-time figure (32 or
   more — a Dutch "36 uur" is the basis its monthly scale is quoted on), and 40
   otherwise. Holiday pay and a 13th month are not added: the figure is what
   the board said, scaled, nothing more.

   A string with no period is only read when the amount can only be yearly
   (15 000 or more). Below that it may be a month, a project budget or a day
   rate — Hoofdkraan's "€50 - €350" is a freelance task's budget — and a wrong
   conversion is worse than none. Deterministic on purpose: no guessing from
   the board or the title. */

// A leading \b never matches before "/" after a space (" /hour"), so the
// slash forms carry no boundary in front.
const PERIODS = [
  [/(\b(per\s+uur|per\s+hour|hourly|p\/u)|\/\s*h(ou)?r)\b/i, "hour"],
  [/(\b(per\s+dag|per\s+day|daily)|\/\s*day)\b/i, "day"],
  [/(\b(per\s+week|weekly)|\/\s*w(ee)?k)\b/i, "week"],
  [/(\b(per\s+maand|per\s+month|monthly|p\/m)|\/\s*mo(nth)?)\b/i, "month"],
  [/(\b(per\s+jaar|per\s+year|annual(ly)?|yearly|p\/j|p\.a)|\/\s*y(ea)?r)\b/i, "year"],
];

const SYMBOLS = { "€": "€", "$": "$", "£": "£" };

/* "3.824" and "50,000" are thousands; "16,21" and "35,3" are decimals. With
   both separators the last one is the decimal point. */
function parseAmount(raw) {
  let s = raw.replace(/\s/g, "");
  const k = /k$/i.test(s);
  s = s.replace(/k$/i, "");
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) {
    const dec = lastDot > lastComma ? "." : ",";
    const thou = dec === "." ? "," : ".";
    s = s.split(thou).join("").replace(dec, ".");
  } else {
    const sep = lastDot !== -1 ? "." : lastComma !== -1 ? "," : null;
    if (sep) {
      const parts = s.split(sep);
      const thousands = parts.length > 2 || parts.at(-1).length === 3;
      s = thousands ? parts.join("") : parts.join(".");
    }
  }
  const n = Number(s);
  return Number.isFinite(n) ? n * (k ? 1000 : 1) : null;
}

function currencyOf(text) {
  const sym = text.match(/[€$£]/);
  if (sym) return SYMBOLS[sym[0]];
  const code = text.match(/\b(EUR|USD|GBP|PLN|PHP|INR|CAD|AUD|NZD|SEK|NOK|DKK|CHF|CZK|RON|HUF|BRL|MXN|ZAR|JPY|SGD)\b/);
  return code ? code[1] : "";
}

export function parseSalary(text) {
  if (!text) return null;
  const str = String(text);
  const nums = [...str.matchAll(/\d[\d.,]*\s?[kK]?(?![a-zA-Z])/g)]
    .map((m) => parseAmount(m[0]))
    .filter((n) => n != null && n > 0);
  if (!nums.length) return null;
  let period = PERIODS.find(([re]) => re.test(str))?.[1] || null;
  let min = nums[0];
  let max = nums.length > 1 ? nums[1] : nums[0];
  if (/^\s*(tot|up\s+to|max)/i.test(str)) min = null;
  else if (/^\s*(vanaf|from|min)/i.test(str) && nums.length === 1) max = null;
  if (min != null && max != null && min > max) [min, max] = [max, min];
  if (!period) {
    if ((min ?? max) >= 15000) period = "year";
    else return null;
  }
  return { min, max, period, currency: currencyOf(str) };
}

const PER_YEAR = { year: () => 1, month: () => 12, week: () => 52, day: () => 260, hour: (h) => h * 52 };

export function hoursPerWeek(job) {
  const h = Number(job?.hoursMax || job?.hoursMin) || 0;
  return h >= 32 && h <= 60 ? h : 40;
}

/* Both figures, or null when the salary cannot be read. */
export function annualise(text, job) {
  const s = parseSalary(text);
  if (!s) return null;
  const hours = hoursPerWeek(job);
  const factor = PER_YEAR[s.period](hours);
  const yearly = (v) => (v == null ? null : v * factor);
  const hourly = (v) => (v == null ? null : (v * factor) / (hours * 52));
  return {
    currency: s.currency,
    period: s.period,
    hours,
    yearly: [yearly(s.min), yearly(s.max)],
    hourly: [hourly(s.min), hourly(s.max)],
  };
}

function money(cur, v, digits) {
  const n = v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return cur.length === 1 ? `${cur}${n}` : cur ? `${cur} ${n}` : n;
}

/* Both ends of a range are written in the unit and precision of the larger,
   so "€70.00–€100.00", never "€70.00–€100". */
function range(cur, [lo, hi], fmt) {
  const top = Math.max(lo ?? 0, hi ?? 0);
  if (lo != null && hi != null) return lo === hi ? fmt(cur, lo, top) : `${fmt(cur, lo, top)}–${fmt(cur, hi, top)}`;
  if (hi != null) return `up to ${fmt(cur, hi, top)}`;
  return `from ${fmt(cur, lo, top)}`;
}

const yearFmt = (cur, v, top) =>
  top >= 1e6 ? money(cur, v / 1e6, 2) + "M" : top >= 1000 ? money(cur, v / 1000, 1) + "k" : money(cur, v, 0);
const hourFmt = (cur, v, top) => money(cur, v, top >= 100 ? 0 : 2);

/* Display strings for the job browser: { yearly, hourly, yearlyBasis, hourlyBasis } or null. */
export function salaryFigures(text, job) {
  const a = annualise(text, job);
  if (!a) return null;
  return {
    yearly: `${range(a.currency, a.yearly, yearFmt)} /yr`,
    hourly: `${range(a.currency, a.hourly, hourFmt)} /h`,
    yearlyBasis: { year: "as stated", month: "12 × monthly", week: "52 × weekly", day: "260 × daily", hour: `hourly × ${a.hours} h × 52 weeks` }[a.period],
    hourlyBasis: a.period === "hour" ? "as stated" : `at ${a.hours} h/week`,
  };
}
