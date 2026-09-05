import { describe, expect, test } from "bun:test";
import { mountApp } from "../lib/harness";
import { stubClient, TOKEN_SHAPE } from "./fixtures";

describe("compose", () => {
  test("i opens compose, alt+enter posts as the human, ROOM shows it as the human", async () => {
    const client = stubClient();
    let quits = 0;
    const h = await mountApp({ client, initialAlias: "scratch", onQuit: () => void quits++ }, { width: 100, height: 30 });
    try {
      await h.until((x) => x.includes("Fable (agent)  cursor 7"));
      h.mockInput.pressKey("i");
      let f = await h.until((x) => x.includes("COMPOSE as Alex"));
      // plain hotkeys are text while composing: q does not quit, digits do not switch members
      await h.mockInput.typeText("q1 hello from the room's human");
      await h.settle();
      f = h.frame();
      expect(quits).toBe(0);
      expect(f).toContain("COMPOSE as Alex");
      expect(f).toContain("q1 hello from the room's human");

      h.mockInput.pressEnter({ meta: true });
      f = await h.until((x) => x.includes("posted stub-8"));
      expect(client.posted).toHaveLength(1);
      expect(client.posted[0].text).toBe("q1 hello from the room's human\n\n-- Alex");
      const back = await client.read("scratch");
      const mine = back.messages[back.messages.length - 1];
      expect(mine.author).toEqual({ id: "Alex", name: "Alex", kind: "human" });
      // the room shows the new post under the human's name and kind, cursor following the tail
      f = await h.until((x) => x.includes("Alex (human)  cursor 8"));
      expect(f).toContain("❯ [");
      expect(f).toContain("-- Alex");
      // compose closed and emptied
      expect(f).toContain("i to compose");
      expect(f).not.toContain("COMPOSE as Alex");
    } finally {
      h.destroy();
    }
  });

  test("a draft carrying a token shape is refused: toast names the reason, nothing is posted, the draft stays", async () => {
    const client = stubClient();
    const h = await mountApp({ client, initialAlias: "scratch" }, { width: 110, height: 30 });
    try {
      await h.until((x) => x.includes("Fable (agent)  cursor 7"));
      h.mockInput.pressKey("i");
      await h.until((x) => x.includes("COMPOSE as Alex"));
      await h.mockInput.typeText(`token here ${TOKEN_SHAPE}`);
      await h.settle();
      h.mockInput.pressEnter({ meta: true });
      const f = await h.until((x) => x.includes("credential shape"));
      expect(f).toContain("it stays in the draft");
      expect(client.posted).toHaveLength(0);
      expect((await client.read("scratch")).messages).toHaveLength(7);
      // the draft is still in the editor (the person's own keystrokes, echoed), compose still open
      expect(f).toContain("COMPOSE as Alex");
      expect(f).toContain("token here");
      // the refusal never echoes the matched shape
      const toastRow = f.split("\n").find((r) => r.includes("credential shape"))!;
      expect(toastRow).not.toContain("xoxb");

      // esc leaves compose; the draft is not sent
      h.mockInput.pressEscape();
      await h.until((x) => x.includes("i to compose"));
      expect(client.posted).toHaveLength(0);
    } finally {
      h.destroy();
    }
  });

  test("an empty draft is refused", async () => {
    const client = stubClient();
    const h = await mountApp({ client, initialAlias: "scratch" }, { width: 100, height: 30 });
    try {
      await h.until((x) => x.includes("Fable (agent)  cursor 7"));
      h.mockInput.pressKey("i");
      await h.until((x) => x.includes("COMPOSE as Alex"));
      h.mockInput.pressEnter({ meta: true });
      await h.until((x) => x.includes("nothing to post"));
      expect(client.posted).toHaveLength(0);
    } finally {
      h.destroy();
    }
  });

  test("with no name yet the overlay asks once, the name is written, and compose posts under it", async () => {
    const client = stubClient({ name: "" });
    const written: string[] = [];
    const h = await mountApp(
      {
        client,
        initialAlias: "scratch",
        needsName: true,
        onName: async (name) => {
          written.push(name);
          return undefined;
        },
      },
      { width: 100, height: 30 },
    );
    try {
      let f = await h.until((x) => x.includes("YOUR NAME"));
      expect(f).toContain("(unnamed)");
      await h.mockInput.typeText("Alex");
      h.mockInput.pressEnter();
      f = await h.until((x) => !x.includes("YOUR NAME") && x.includes("agora · Alex (human)"));
      expect(written).toEqual(["Alex"]);
      expect(client.actor()).toEqual({ name: "Alex", kind: "human" });
      h.mockInput.pressKey("i");
      await h.until((x) => x.includes("COMPOSE as Alex"));
      await h.mockInput.typeText("named now");
      h.mockInput.pressEnter({ meta: true });
      await h.until((x) => x.includes("posted stub-8"));
      expect(client.posted[0].text).toBe("named now\n\n-- Alex");
    } finally {
      h.destroy();
    }
  });
});
