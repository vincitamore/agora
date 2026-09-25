// @ts-check
/**
 * `agora tui`: hand this terminal to the human surface in `tui/`.
 *
 * The root CLI stays zero-dependency and never imports that package: this launches it as a child,
 * the way `agora codex` launches the Codex TUI. Bun is resolved the way every other launcher here
 * resolves it (`BUN`, else `~/.bun/bin`, never PATH), the entry and its install are checked before
 * anything is spawned so a missing toolchain is named rather than discovered as a stack trace, and
 * the child inherits this terminal and this working directory: a relative `./agora.json` then means
 * what it means for every other verb, and the TUI's own imports resolve from its file's directory.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgoraError, EXIT } from "./core.mjs";
import { resolveBunBin } from "./spawn-pane.mjs";

export const TUI_PACKAGE = fileURLToPath(new URL("../tui/", import.meta.url));

/**
 * @param {object} options
 * @param {string[]} [options.args] arguments after the verb: `[room] [--name <you>] [--config <p>]`
 * @param {string} [options.root] the tui package directory; the shipped one by default
 * @param {string} [options.config] the `--config` this invocation resolved, forwarded when the
 *   arguments do not carry one of their own
 * @param {() => string | null} [options.resolveBun] injected for the tests
 * @param {typeof nodeSpawn} [options.spawn] injected for the tests
 * @returns {Promise<number>} the child's exit code
 */
export async function launchTui({ args = [], root = TUI_PACKAGE, config, resolveBun = resolveBunBin, spawn = nodeSpawn } = {}) {
  const entry = path.join(root, "index.tsx");
  if (!existsSync(entry)) throw new AgoraError(`tui-entry-absent: no ${entry}; this build does not carry the tui package`, EXIT.error);
  if (!existsSync(path.join(root, "node_modules"))) {
    throw new AgoraError(`tui-not-installed: ${root} has no node_modules; run \`bun install\` there once (the root CLI needs none of it)`, EXIT.error);
  }
  const bun = resolveBun();
  if (!bun) throw new AgoraError("tui-bun-absent: no bun at BUN or ~/.bun/bin; the human surface is a Bun package", EXIT.error);
  const forwarded = config !== undefined && !args.includes("--config") ? ["--config", config] : [];
  const child = spawn(bun, [entry, ...args, ...forwarded], { stdio: "inherit" });
  return await new Promise((resolve, reject) => {
    child.on("error", (error) => reject(new AgoraError(`tui-spawn-failed: ${bun}: ${error.message}`, EXIT.error)));
    child.on("exit", (code, signal) => resolve(signal ? EXIT.error : (code ?? EXIT.error)));
  });
}
