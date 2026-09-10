/* Eligibility filtering for the remote boards.

   A remote board is worldwide, and most of what it carries is not open to
   someone in the Netherlands: "Remote (US only)" is the single most common
   listing on every one of them. Each board states eligibility in its own way —
   Himalayas has `locationRestrictions`, Remotive a comma-joined
   `candidate_required_location`, We Work Remotely a `<region>` element — so
   every adapter reduces that to plain place names and this decides.

   The rule: keep a listing when its stated region matches `regionInclude`, or
   when it states nothing at all (unknown is not the same as excluded, and the
   alternative throws away too much). Drop it when it names regions and none of
   them match. `regionExclude` overrides an include match, for the cases where
   a board tags a job both "Worldwide" and "US only". */

export const DEFAULT_INCLUDE =
  "netherlands|nederland|holland|dutch|europe|european|emea|eu\\b|eea\\b|benelux|" +
  "worldwide|anywhere|global|remote, ?global|any location|all locations|international|" +
  "cet|cest|utc[+ ]?[012]|gmt[+ ]?[012]|" +
  "belgium|germany|deutschland|united kingdom|uk\\b|ireland|france|spain|portugal|" +
  "italy|poland|sweden|denmark|norway|finland|austria|switzerland|czech";

export const DEFAULT_EXCLUDE = "";

export function makeRegionFilter(cfg = {}) {
  const include = cfg.regionInclude === null ? null : new RegExp(cfg.regionInclude || DEFAULT_INCLUDE, "i");
  const exclude = cfg.regionExclude ? new RegExp(cfg.regionExclude, "i") : null;
  const keepUnknown = cfg.keepUnknownRegion !== false;

  return function eligible(regions) {
    const list = (Array.isArray(regions) ? regions : [regions]).map((r) => String(r ?? "").trim()).filter(Boolean);
    if (!list.length) return keepUnknown;
    if (!include) return true;
    const text = list.join(" | ");
    if (exclude && exclude.test(text)) return false;
    return include.test(text);
  };
}

/* Boards write eligibility as one string ("LATAM, Europe, USA"), as a list, or
   not at all. This normalises all three into a list of names. */
export function splitRegions(value) {
  if (value == null) return [];
  const parts = Array.isArray(value) ? value : String(value).split(/[,;/]|\bor\b|\band\b/i);
  return [...new Set(parts.map((p) => String(p ?? "").trim()).filter(Boolean))];
}
