/**
 * What compose refuses, and how a draft becomes a post. The refusal names the reason and never
 * echoes the match: the draft stays in the editor, nothing is appended. The post is signed the
 * way the CLI signs, `-- <name>`, through the same `sign()`.
 */

import { redact, sign } from "../../src/core.mjs";
import type { HumanActor } from "./room-client";

export interface ComposeGuardOptions {
  /** The seat service nonce, when a service is running; a draft carrying it is refused. */
  nonce?: string;
}

/** The nonce clause on its own: the seat service client applies it without handing the nonce out. */
export function nonceRefusal(text: string, nonce: string | undefined): string | undefined {
  if (nonce && nonce.length >= 8 && text.includes(nonce)) return "the draft carries the seat service nonce; it stays in the draft and nothing was posted";
  return undefined;
}

/** Why the draft cannot be posted, or nothing. */
export function composeRefusal(text: string, actor: HumanActor, opts: ComposeGuardOptions = {}): string | undefined {
  if (!actor.name.trim()) return "no name yet: this seat's human has not been named";
  if (!text.trim()) return "nothing to post";
  if (redact(text) !== text) return "the draft carries a credential shape; it stays in the draft and nothing was posted";
  return nonceRefusal(text, opts.nonce);
}

/** The text that goes to the room: trailing whitespace dropped, signed as the human. */
export function preparePost(text: string, actor: HumanActor): string {
  return sign(text.replace(/\s+$/, ""), actor);
}
