// @ts-check
/**
 * Lineage: which model family a position may run on, given the families of the positions it must
 * differ from.
 *
 * A model's family is read from its model id, never from a bearer: the model segment of
 * `provider/model:thinking` (`google-antigravity/claude-opus-5-5:high` is `claude`,
 * `gemini-4-argon` is `gemini`). A bearer names the model (`review/Opus`), which hides the family,
 * and a provider can serve several families, so neither is evidence.
 *
 * A manifest row declares its rule in `lineage`: `any` (the default) or `different-from-<role>`,
 * which binds the row against every position of that role in the same room (the position less its
 * last segment), both ways: a review row that differs from coding refuses a start on coding's
 * family, and a coding position refuses a start on the family a live review runs. Only positions in
 * force are compared (a live session at the position, or a host the last start recorded), each by
 * the model it actually runs: its session record's model, else its run record's, else its row's.
 *
 * Pure: the callers read the records.
 */

/** The rule values a row may carry. */
export const LINEAGE_RE = /^(?:any|different-from-[a-z0-9][a-z0-9_-]{0,63})$/;

/**
 * The model family of a model id: the model segment (after the last `/`, before `:`), by its
 * leading word; `claude-*`, `gemini-*`, `gpt-*` / `o<n>` / `codex*`, `grok-*` are named, anything
 * else is its first word.
 * @param {string} id
 */
export function modelFamily(id) {
  const seg = String(id).split("/").pop()?.split(":")[0].trim().toLowerCase() ?? "";
  if (seg.startsWith("claude")) return "claude";
  if (seg.startsWith("gemini")) return "gemini";
  if (/^(gpt|o\d|codex)/.test(seg)) return "openai";
  if (seg.startsWith("grok")) return "xai";
  return seg.split(/[-_.]/)[0];
}

/**
 * The role a lineage rule must differ from, or null for `any`. Throws on a value that is not a rule.
 * @param {string} rule
 */
export function differentFrom(rule) {
  if (!LINEAGE_RE.test(rule)) throw new Error(`lineage must be "any" or "different-from-<role>", not ${JSON.stringify(rule)}`);
  return rule === "any" ? null : rule.slice("different-from-".length);
}

/** The room a position belongs to: the position less its last segment. @param {string} position */
export function roomOfPosition(position) {
  const dot = position.lastIndexOf(".");
  return dot < 0 ? "" : position.slice(0, dot);
}

/**
 * @typedef {{ slug: string, role: string, model: string, lineage: string, harness?: string }} LineageRow
 * @typedef {{ position: string, rule: string, rowModel: string }} Counterpart
 */

/**
 * The positions a start at `slug` must differ from in family, with the rule that binds each pair:
 * the rows of the role this row's rule names, and the rows whose rule names this row's role, in the
 * same room. A messenger row (harness agora) runs no model and binds nothing.
 * @param {Record<string, LineageRow>} rows the manifest's rows, granted positions included
 * @param {string} slug
 * @returns {Counterpart[]}
 */
export function counterparts(rows, slug) {
  const me = rows[slug];
  if (!me || me.harness === "agora") return [];
  const room = roomOfPosition(slug);
  const mine = differentFrom(me.lineage);
  /** @type {Counterpart[]} */
  const out = [];
  for (const r of Object.values(rows)) {
    if (r.slug === slug || r.harness === "agora" || roomOfPosition(r.slug) !== room) continue;
    const theirs = differentFrom(r.lineage);
    if (mine !== null && r.role === mine) out.push({ position: r.slug, rule: `${slug} differs from ${mine}`, rowModel: r.model });
    else if (theirs !== null && me.role === theirs) out.push({ position: r.slug, rule: `${r.slug} differs from ${theirs}`, rowModel: r.model });
  }
  return out;
}

/**
 * The first pair a start on `model` would break, as the refusal's text; null when none.
 * @param {{ slug: string, model: string }} start
 * @param {Array<Counterpart & { model: string, source: string }>} inForce the counterparts in force, each with the model it runs and where that was read
 */
export function lineageClash(start, inForce) {
  const fam = modelFamily(start.model);
  for (const c of inForce) {
    if (modelFamily(c.model) !== fam) continue;
    return `lineage: ${start.slug} on ${start.model} is family ${fam}, the family ${c.position} runs (${c.model}, from its ${c.source}); the manifest says ${c.rule}`;
  }
  return null;
}
