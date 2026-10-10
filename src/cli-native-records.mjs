// @ts-check
/**
 * The native record verbs: attachments, annotations and purge on a native room (docs/PURGE.md lists
 * them; docs/ATTACHMENTS.md and docs/ANNOTATIONS.md are the records they write).
 *
 *   agora post <room> --attach <path> [--attach <path> ...]
 *   agora attachment get <room> <attachment id> --out <path>
 *   agora edit <room> <message id> (--stdin | --text "...")
 *   agora withdraw <room> <message id>
 *   agora pin <room> <message id>
 *   agora unpin <room> <message id>
 *   agora room purge <room> (--message <id> ... | --thread <root id>) --reason "..."
 *
 * The CLI dispatches every one of them here: `nativeRecordVerb` names the verb a command line is,
 * `nativeRecordArgumentRefusal` refuses its arguments before any config is read, `runNativeRecordVerb`
 * runs it once config, session and bearer are resolved, and `prepareAttachments` turns `post --attach`
 * paths into the references the post carries.
 *
 * In this build none of them is implemented: each refuses `not-implemented` with exit 1 and writes
 * nothing. The exit codes are the CLI's contract (0, 1, 2, 42), so not-implemented is an error
 * named in its message, never a new code.
 */

import { AgoraError, EXIT } from "./core.mjs";

/** @typedef {'attachment-get' | 'edit' | 'withdraw' | 'pin' | 'unpin' | 'room-purge'} NativeRecordVerb */

/** Every native record verb, as `nativeRecordVerb` names them. `post --attach` is a post option. */
export const NATIVE_RECORD_VERBS = Object.freeze(/** @type {const} */ (["attachment-get", "edit", "withdraw", "pin", "unpin", "room-purge"]));

/**
 * Which native record verb this command line is, if any.
 * @param {string} verb @param {string | undefined} sub the second positional
 * @returns {NativeRecordVerb | undefined}
 */
export function nativeRecordVerb(verb, sub) {
  if (verb === "attachment") return "attachment-get";
  if (verb === "edit" || verb === "withdraw" || verb === "pin" || verb === "unpin") return verb;
  if (verb === "room" && sub === "purge") return "room-purge";
  return undefined;
}

/**
 * The arguments refusal for a native record verb, checked before config loads; undefined when the
 * arguments are well formed.
 * @param {{ verb: string, roomAlias: string | undefined, rest: string[], values: Record<string, unknown> }} context
 * @returns {string | undefined}
 */
export function nativeRecordArgumentRefusal(context) {
  void context;
  return undefined;
}

/**
 * What the CLI hands a native record verb once config, session and bearer are resolved.
 * @typedef {{
 *   name: NativeRecordVerb,
 *   sub: string | undefined,
 *   rest: string[],
 *   values: Record<string, unknown>,
 *   cfg: import("./core.mjs").Config,
 *   stateRoot: string,
 *   sessionDir: string,
 *   bearer: { name: string, source: string },
 *   json: boolean,
 * }} NativeRecordContext
 */

/** @param {string} what */
function notImplemented(what) {
  return new AgoraError(`not-implemented: ${what} is not implemented in this build; nothing was written`, EXIT.error);
}

/**
 * Run one native record verb; resolves with the exit code.
 * @param {NativeRecordContext} context
 * @returns {Promise<number>}
 */
export async function runNativeRecordVerb(context) {
  const label = context.name === "attachment-get" ? "agora attachment get"
    : context.name === "room-purge" ? "agora room purge" : `agora ${context.name}`;
  throw notImplemented(label);
}

/**
 * `post --attach`: upload each path into the room's custody and resolve with the references the
 * post carries, in the order given.
 * @param {{ roomAlias: string, room: Record<string, any>, cfg: import("./core.mjs").Config, stateRoot: string, paths: string[] }} context
 * @returns {Promise<import("./protocol/attachment.mjs").WireAttachment[]>}
 */
export async function prepareAttachments(context) {
  void context;
  throw notImplemented("agora post --attach");
}
