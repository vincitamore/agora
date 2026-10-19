#!/usr/bin/env bash
# Start a resident OMP (@oh-my-pi) session from a profile (POSIX).
#
#   scripts/start-omp-resident.sh --slug <slug> --profile <path> [--model <name>] [--thinking <level>]
#                                 [--resume <session-id>] [--skills <csv>] [--cwd <dir>]
#
# Renders the prompt (`agora resident prompt`: the profile plus the shipped room-mechanics block)
# to the seat's state under residents/<slug>/, moves to --cwd (the tree the resident works in),
# and runs `omp` with the rendered file appended to the system prompt and yolo approval mode.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agora="$here/../bin/agora.mjs"

slug=""; profile=""; model=""; thinking=""; resume=""; skills=""; cwd=""
while [ $# -gt 0 ]; do
  case "$1" in
    --slug)     slug="$2"; shift 2 ;;
    --profile)  profile="$2"; shift 2 ;;
    --model)    model="$2"; shift 2 ;;
    --thinking) thinking="$2"; shift 2 ;;
    --resume)   resume="$2"; shift 2 ;;
    --skills)   skills="$2"; shift 2 ;;
    --cwd)      cwd="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$slug" ] || { echo "--slug is required" >&2; exit 2; }
[ -n "$profile" ] || { echo "--profile is required" >&2; exit 2; }
[ -f "$profile" ] || { echo "profile missing: $profile" >&2; exit 1; }

state="${AGORA_STATE:-$HOME/.agora/state}"
outdir="$state/residents/$slug"
mkdir -p "$outdir"
rendered="$outdir/profile.rendered.md"
node "$agora" resident prompt "$profile" > "$rendered"

[ -n "$cwd" ] && cd "$cwd"

args=(--append-system-prompt "$rendered" --approval-mode yolo)
[ -n "$model" ]    && args+=(--model "$model")
[ -n "$thinking" ] && args+=(--thinking "$thinking")
[ -n "$skills" ]   && args+=(--skills "$skills")
if [ -n "$resume" ]; then
  args+=(--resume "$resume")
else
  args+=("You are the $slug resident. Run the arming sequence in your profile now, then report the room state in one line.")
fi
exec omp "${args[@]}"
