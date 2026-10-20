// @ts-check
/**
 * S19 · messenger-deaf. The messenger runs as its manifest row's program would (`messenger
 * --stream` under its own position and session), on bounds scaled to seconds so the clocks run in
 * real time. While it is up, a question to a position goes untaken and the stream posts its N2. The
 * stream is killed by its pid. While it is down, three incidents arise: another untaken question,
 * an address that names no holder, and a reply posted at top level. Then the cycle's backstop runs
 * (`resident cycle <position>` on the manifest: one `--once` tick), twice, and the stream is
 * started again for a few seconds.
 *
 * Bars: the stream posted while up; the backstop reports the stream gone and handles every
 * incident raised while it was down; afterwards no incident stands twice in the room.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatNotice } from "../../src/messenger.mjs";
import { openSeat } from "./lib/seat.mjs";
import { Agent, Human, openClient } from "./lib/participants.mjs";
import { HOST_HUMAN, MESSENGER_BEARER, MESSENGER_SESSION, duplicates } from "./lib/messenger-rig.mjs";

const R_SECONDS = 3;
const BOUNDS = `R=${R_SECONDS}s,R2=600s,I=2s,Bo=600s,T=1s`;
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @type {import("./lib/scenarios.mjs").Scenario} */
export const scenario = {
  id: "S19",
  name: "messenger-deaf",
  checks: {
    "stream-posts-while-up": {
      bar: "the stream posts one N2 for the question left untaken while it runs",
      redLeg: "the stream runs with R far past the wait (R=600s), so nothing comes due while it is up",
    },
    "backstop-sees-stream-gone": {
      bar: "the cycle's backstop tick reports the messenger's stream gone after the kill",
      redLeg: "the stream is not killed, only left to run",
    },
    "handled-after-restart": {
      bar: "every incident raised while the messenger was down has its notice after the backstop tick (3 of 3)",
      redLeg: "the cycle names another resident, so no backstop tick runs",
    },
    "no-duplicates": {
      bar: "0 incidents stand twice in the room after two backstop ticks and a restarted stream",
      redLeg: "an unsynchronised second poster repeats one notice by hand",
    },
  },
  async run(ctx) {
    const seat = await openSeat();
    /** @type {any} */
    let client;
    try {
      client = await openClient(seat);
      const ada = new Human(client, seat.alias, HOST_HUMAN);
      const coding = await Agent.start(seat, { session: "s19-coding", bearer: "coding/Opus", label: "desk.coding", harness: "omp" });
      const manifest = path.join(seat.root, "residents.json");
      await writeFile(manifest, JSON.stringify({ version: 1, residents: {
        [MESSENGER_SESSION]: { role: "messenger", harness: "agora", rooms: [seat.alias], host: "none", args: ["--human-name", HOST_HUMAN, "--bounds", BOUNDS] },
        "desk.other": { role: "other", harness: "agora", rooms: [seat.alias], host: "none", args: ["--human-name", HOST_HUMAN, "--bounds", BOUNDS, "--dry-run"] },
      } }));
      const env = { AGORA_SESSION: MESSENGER_SESSION, AGORA_ACTOR: MESSENGER_BEARER, AGORA_LABEL: MESSENGER_SESSION };
      const streamBounds = ctx.red("stream-posts-while-up") ? "R=600s,R2=1200s,I=2s,Bo=600s,T=1s" : BOUNDS;
      const stream = seat.cliBackground(["messenger", seat.alias, "--stream", "--for", "60", "--human-name", HOST_HUMAN, "--bounds", streamBounds, "--json"], env);
      const liveness = path.join(seat.state, "messenger", `${MESSENGER_SESSION}.${seat.alias}.json`);
      for (let i = 0; i < 100; i++) {
        try { if (JSON.parse(await readFile(liveness, "utf8")).ticks >= 1) break; } catch { /* not yet */ }
        await sleep(100);
      }

      const q0 = await ada.post("Can you check the build cache?", { to: ["coding"] });
      /** the notices the room holds, by kind and the id each is for */
      const notices = async () => {
        const r = await seat.cli(["read", seat.alias, "--json", "--limit", "1000"]);
        const { parseNotice } = await import("../../src/messenger.mjs");
        return r.stdout.split(/\r?\n/).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).filter((m) => m.type === "message")
          .map((m) => ({ m, n: parseNotice(m.text) })).filter((x) => x.n).map(({ m, n }) => ({ id: m.id, ...n, by: m.signedAs ?? m.author?.name }));
      };
      const deadline = Date.now() + (R_SECONDS + 8) * 1000;
      let upN2 = 0;
      while (Date.now() < deadline) {
        upN2 = (await notices()).filter((n) => n.kind === "N2" && /** @type {any} */ (n).fields.id === q0.id).length;
        if (upN2) break;
        await sleep(250);
      }
      ctx.check("stream-posts-while-up", 1, upN2, { bounds: { R_SECONDS } });

      if (!ctx.red("backstop-sees-stream-gone")) await seat.kill(stream.pid);
      // down: three incidents
      const q1 = await ada.post("And the release tag, can you cut it?", { to: ["coding"] });
      const typo = await ada.post("Whoever owns the importer, please look.", { to: ["imp"] });
      const top = await coding.post("The cache is fine.", { re: q0.id });
      await sleep(R_SECONDS * 1000 + 1500);

      const cycle = async () => {
        const r = await seat.cli(["resident", "cycle", ctx.red("handled-after-restart") ? "desk.other" : MESSENGER_SESSION, "--manifest", manifest, "--json"]);
        const line = r.stdout.split(/\r?\n/).find((l) => l.includes('"resident-cycle"'));
        if (!line) throw new Error(`cycle printed no row (exit ${r.code}): ${r.stdout}${r.stderr}`);
        return JSON.parse(line);
      };
      const first = await cycle();
      ctx.check("backstop-sees-stream-gone", "gone", first.stream ?? null);
      const after = await notices();
      const handled = [after.some((n) => n.kind === "N2" && /** @type {any} */ (n).fields.id === q1.id),
        after.some((n) => n.kind === "N5" && n.re === typo.id), after.some((n) => n.kind === "N7" && n.re === top.id)].filter(Boolean).length;
      ctx.check("handled-after-restart", { raised: 3, handled: 3 }, { raised: 3, handled });

      await cycle();
      if (!ctx.red("backstop-sees-stream-gone")) {
        const again = seat.cliBackground(["messenger", seat.alias, "--stream", "--for", "3", "--human-name", HOST_HUMAN, "--bounds", BOUNDS, "--json"], env);
        await again.done;
      }
      if (ctx.red("no-duplicates")) {
        const dup = /** @type {any} */ ((await notices()).find((n) => n.kind === "N5"));
        if (dup) await coding.ok(["post", seat.alias, formatNotice("N5", dup.fields), "--re", String(dup.re), "--thread", typo.id]);
      }
      ctx.check("no-duplicates", 0, duplicates(/** @type {any} */ (await notices())));
    } finally {
      client?.close();
      await seat.close();
    }
  },
};
