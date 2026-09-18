// A room, written out as a record another checker can read. The layout is the collective-record
// layout that the singulis conformance suite loads (`config.md`, `members/<id>.md`,
// `messages/<id>.md`, `artifacts/<id>.md`, every file Markdown with a frontmatter block), so a
// live room can be handed to that suite and its proven settlement ledger evaluates what the
// room's verdicts and withdrawals leave standing.
//
// This is a read: nothing in the room is delivered, no cursor moves, no wake fires, and the tool
// acts on nothing it finds. It does render every participant's trailers into the record, the
// way `read` prints them, because the record is for a reader who asked for exactly that; the
// standing prohibition is against a trailer steering THIS tool, and here no trailer steers
// anything. The mapping is one-to-one and stated here so the checker's reading can be traced
// back to a post:
//
//   every message                       -> messages/<id>.md   (from, to, date, cursor, thread,
//                                                              kind, trailers; body verbatim)
//   a post carrying `verdict:`          -> artifacts/<id>.md  kind: settlement, with its
//                                          exhibits; and, when it answers an earlier verdict in
//                                          the window by `re:`, `retracts:` that post under a
//                                          coordination step naming the author
//   a post carrying `withdraws:`        -> artifacts/<id>.md  kind: settlement, `retracts:` the
//                                          post it names (id or cursor, resolved inside the
//                                          window when it can be), under the author's step
//   every agent author                  -> members/<slug>.md
//   every human author                  -> config.md `persons`
//   config.md                           -> the record's clock (`as-of`, the newest message) and
//                                          where the window came from
//
// Frontmatter is written as JSON, which every YAML reader accepts as a flow mapping, so no
// value needs quoting rules of its own. Nothing is invented: a field the room does not carry is
// absent, and a checker that needs it reports its absence.

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseTrailers } from "./trailers.mjs";

/** @typedef {import("./core.mjs").Message} Message */

/** @param {string} name */
export function memberSlug(name) {
  return name.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}

/**
 * @param {Record<string, unknown>} fm
 * @param {string} body
 */
function doc(fm, body) {
  return `---\n${JSON.stringify(fm, null, 2)}\n---\n${body.endsWith("\n") ? body : body + "\n"}`;
}

/**
 * Fold a window into record files. Pure: the same window gives the same files.
 * @param {Message[]} msgs ascending
 * @param {{ alias: string, transport: string, room: string }} source
 * @returns {{ files: Map<string, string>, summary: { messages: number, artifacts: number, retractions: number, unresolved: number, members: string[], persons: string[], oldest: string | null, newest: string | null } }}
 */
export function buildRecord(msgs, source) {
  const files = new Map();
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const byCursor = new Map(msgs.map((m) => [m.cursor, m]));
  /** a verdict post's id, by the id or cursor a later post may name */
  const verdictIds = new Set();
  /** @type {Map<string, { name: string, kind: string, id: string, first: string, last: string, posts: number }>} */
  const authors = new Map();
  let artifacts = 0;
  let retractions = 0;
  /** `withdraws:` or `re:` values naming a post outside the window */
  let unresolved = 0;

  for (const m of msgs) {
    const name = m.signedAs ?? m.author.name;
    const slug = memberSlug(name);
    const a = authors.get(slug) ?? { name, kind: m.author.kind, id: m.author.id, first: m.ts, last: m.ts, posts: 0 };
    a.last = m.ts;
    a.posts += 1;
    authors.set(slug, a);

    const { trailers, to } = parseTrailers(m.text);
    files.set(`messages/${m.id}.md`, doc({
      from: slug,
      ...(to.length ? { to } : {}),
      date: m.ts,
      cursor: m.cursor,
      ...(m.thread ? { thread: m.thread } : {}),
      kind: m.author.kind,
      ...(m.url ? { url: m.url } : {}),
      ...(trailers.length ? { trailers } : {}),
    }, m.text));

    const verdicts = trailers.filter((t) => t.key === "verdict").map((t) => t.value);
    // a `withdraws:` or `re:` value may name several posts, comma-separated, as `carry` reads it
    const named = (/** @type {string} */ key) => trailers.filter((t) => t.key === key).flatMap((t) => t.value.split(",").map((v) => v.trim()).filter(Boolean));
    const withdraws = named("withdraws");
    const exhibits = trailers.filter((t) => t.key === "exhibit").map((t) => t.value);
    const re = named("re");
    if (!verdicts.length && !withdraws.length) continue;

    // A retraction is written only where carry would read one: the named post is in the window
    // AND it is this author's own. A `re:` or `withdraws:` naming another author's verdict is
    // that author's fact being contested, not withdrawn; writing it as `retracts:` under a step
    // naming only the contester would hand the singulis ledger an uncoordinated retraction dressed
    // as a coordinated one (the member whose fact is withdrawn absent from the step). A post named
    // outside the window is not asserted here, so there is nothing to retract; it is counted.
    /** @param {string} named */
    const resolve = (named) => byId.get(named) ?? byCursor.get(named);
    /** @param {string} named @returns {string | null} */
    const own = (named) => {
      const target = resolve(named);
      if (!target) { unresolved += 1; return null; }
      return memberSlug(target.signedAs ?? target.author.name) === slug ? target.id : null;
    };
    /** @type {string[]} */
    const retracts = [];
    for (const id of withdraws.map(own)) if (id !== null) retracts.push(id);
    for (const id of re.map(own)) if (id !== null && verdicts.length && verdictIds.has(id)) retracts.push(id);
    if (verdicts.length) verdictIds.add(m.id);
    // The singulis mapping reads a settlement artifact as EITHER an assertion OR one retraction
    // (`retracts:` makes it a Retract and nothing else), and the kernel's Retract names one fact.
    // So a post is split: one `<id>.r<n>` artifact per post it takes back, and, when it carries a
    // verdict, one `<id>` artifact asserting its own fact. Each carries the message id, so the
    // reader can find the one post behind them.
    const base = {
      kind: "settlement",
      author: slug,
      date: m.ts,
      message: m.id,
      cursor: m.cursor,
      "fact-apt": true,
      live: true,
      ...(re.length ? { re } : {}),
    };
    retracts.forEach((target, i) => {
      artifacts += 1;
      retractions += 1;
      files.set(`artifacts/${m.id}.r${i + 1}.md`, doc({ ...base, retracts: target, "coordination-step": [slug] }, m.text));
    });
    if (verdicts.length) {
      artifacts += 1;
      files.set(`artifacts/${m.id}.md`, doc({
        ...base,
        verdict: verdicts.length === 1 ? verdicts[0] : verdicts,
        ...(exhibits.length ? { exhibits } : {}),
      }, m.text));
    }
  }

  /** @type {string[]} */
  const members = [];
  /** @type {string[]} */
  const persons = [];
  for (const [slug, a] of authors) {
    if (a.kind === "human") { persons.push(slug); continue; }
    members.push(slug);
    files.set(`members/${slug}.md`, doc({
      name: a.name,
      kind: a.kind,
      "account-id": a.id,
      "first-post": a.first,
      "last-post": a.last,
      posts: a.posts,
    }, `# ${a.name}\n\nA participant of room ${source.alias}, as the transport named it.`));
  }
  const oldest = msgs[0]?.ts ?? null;
  const newest = msgs.at(-1)?.ts ?? null;
  files.set("config.md", doc({
    collective: source.alias,
    "as-of": newest,
    persons,
    source: {
      alias: source.alias,
      transport: source.transport,
      room: source.room,
      messages: msgs.length,
      oldest: msgs[0]?.cursor ?? null,
      newest: msgs.at(-1)?.cursor ?? null,
    },
  }, `# ${source.alias}\n\nExported from an agora room by \`agora export-record\`; the room is the source and this record a reading of it.`));

  return { files, summary: { messages: msgs.length, artifacts, retractions, unresolved, members: members.sort(), persons: persons.sort(), oldest, newest } };
}

/**
 * Write the files under `dir`, which must not already hold anything.
 * @param {string} dir
 * @param {Map<string, string>} files
 */
export async function writeRecord(dir, files) {
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length) throw Object.assign(new Error(`${dir} is not empty; export into a fresh directory`), { code: "export-target-not-empty" });
  for (const [rel, content] of files) {
    const full = join(dir, ...rel.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}
