#!/usr/bin/env bash
# Start a resident Claude Code session from a profile (POSIX).
#
#   scripts/start-claude-resident.sh --slug <slug> --profile <path> [--model <name>] [--effort <level>]
#                                    [--resume <session-id>] [--cwd <dir>]
#
# Renders the prompt (`agora resident prompt`: the profile plus the shipped room-mechanics block)
# to the seat's state under residents/<slug>/, moves to --cwd (the tree the resident works in),
# and runs Claude Code with the rendered file as the whole system prompt. A seat launcher that
# exports its own markers wraps this script. See docs/RESIDENTS.md.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agora="$here/../bin/agora.mjs"

slug=""; profile=""; model=""; effort=""; resume=""; cwd=""
while [ $# -gt 0 ]; do
  case "$1" in
    --slug)    slug="$2"; shift 2 ;;
    --profile) profile="$2"; shift 2 ;;
    --model)   model="$2"; shift 2 ;;
    --effort)  effort="$2"; shift 2 ;;
    --resume)  resume="$2"; shift 2 ;;
    --cwd)     cwd="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$slug" ] || { echo "--slug is required" >&2; exit 2; }
[ -n "$profile" ] || { echo "--profile is required" >&2; exit 2; }
[ -f "$profile" ] || { echo "profile missing: $profile" >&2; exit 1; }

state="${AGORA_STATE:-$HOME/.agora}"
outdir="$state/residents/$slug"
mkdir -p "$outdir"
rendered="$outdir/profile.rendered.md"
node "$agora" resident prompt "$profile" > "$rendered"

[ -n "$cwd" ] && cd "$cwd"

args=(--system-prompt "." --append-system-prompt-file "$rendered" --dangerously-skip-permissions)
[ -n "$model" ]  && args+=(--model "$model")
[ -n "$effort" ] && args+=(--effort "$effort")
if [ -n "$resume" ]; then
  args+=(--resume "$resume")
else
  args+=("You are the $slug resident. Run the arming sequence in your profile now, then report the room state in one line.")
fi
exec claude "${args[@]}"
