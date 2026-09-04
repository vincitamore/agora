#!/bin/sh
set -eu

room=
actor=
session_id=${CODEX_SESSION_ID:-${CODEX_THREAD_ID:-}}
thread_id=${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-}}
config_path=${AGORA_CONFIG:-${HOME}/.agora/config.json}
state_root=${AGORA_STATE:-${HOME}/.agora/state}
runtime_path=
codex_path=${AGORA_CODEX_BIN:-}
log_prefix=${TMPDIR:-/tmp}/agora-codex-watch
status=false
stop=false
force=false
worker=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --room|-Room) room=$2; shift 2 ;;
    --actor|-Actor) actor=$2; shift 2 ;;
    --session-id|-SessionId) session_id=$2; shift 2 ;;
    --thread-id|-ThreadId) thread_id=$2; shift 2 ;;
    --config|-ConfigPath) config_path=$2; shift 2 ;;
    --state|-StateRoot) state_root=$2; shift 2 ;;
    --runtime|-RuntimePath|-BunPath) runtime_path=$2; shift 2 ;;
    --codex-bin|-CodexPath) codex_path=$2; shift 2 ;;
    --log-prefix|-LogPrefix) log_prefix=$2; shift 2 ;;
    --status|-Status) status=true; shift ;;
    --stop|-Stop) stop=true; shift ;;
    --force|-Force) force=true; shift ;;
    --worker) worker=true; shift ;;
    *) printf '%s\n' "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -n "$room" ] || { printf '%s\n' '--room is required' >&2; exit 2; }
case "$session_id" in
  ''|*[!A-Za-z0-9-]*) printf '%s\n' 'A Codex CODEX_SESSION_ID is required for the stable watch session.' >&2; exit 2 ;;
esac
[ "${#session_id}" -ge 8 ] && [ "${#session_id}" -le 128 ] || {
  printf '%s\n' 'A Codex session id must be 8-128 characters.' >&2; exit 2;
}
case "$thread_id" in
  ''|*[!A-Za-z0-9-]*) printf '%s\n' 'A Codex CODEX_THREAD_ID or CODEX_SESSION_ID is required for the queue target.' >&2; exit 2 ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
agora_path=$(CDPATH= cd -- "$script_dir/../bin" && pwd)/agora.mjs
session_slug=codex-$session_id
armed_path=$state_root/sessions/$session_slug/armed/$room.json

armed_pid() {
  [ -f "$armed_path" ] || return 0
  sed -n 's/^[[:space:]]*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$armed_path" | head -n 1
}

json_string() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

pid=$(armed_pid)
alive=false
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=true; fi

if [ "$status" = true ]; then
  printf '{"room":"%s","session":"%s","watcherPid":%s,"supervisorPid":%s,"alive":%s,"armed":"%s"}\n' \
    "$(json_string "$room")" "$(json_string "$session_id")" "${pid:-null}" "${pid:-null}" "$alive" "$(json_string "$armed_path")"
  exit 0
fi

if [ "$stop" = true ]; then
  stopped=false
  if [ "$alive" = true ]; then
    kill "$pid" 2>/dev/null || true
    stopped=true
  fi
  rm -f -- "$armed_path"
  printf '{"room":"%s","session":"%s","stopped":%s,"watcherPid":%s,"supervisorPid":%s,"armed":"%s"}\n' \
    "$(json_string "$room")" "$(json_string "$session_id")" "$stopped" "${pid:-null}" "${pid:-null}" "$(json_string "$armed_path")"
  exit 0
fi

if [ "$worker" != true ] && [ -z "$actor" ]; then
  printf '%s\n' '--actor is required when arming a watch' >&2
  exit 2
fi

if [ "$alive" = true ]; then
  if [ "$force" != true ]; then
    printf '%s\n' "A live watch already holds $room for this Codex session (pid $pid). Use --status, --stop, or --force." >&2
    exit 1
  fi
  kill "$pid" 2>/dev/null || true
  rm -f -- "$armed_path"
fi
if [ "$worker" != true ] && [ "$alive" = false ] && [ -f "$armed_path" ]; then
  # Do not let the spawn loop mistake a dead record for the watcher being started now.
  rm -f -- "$armed_path"
fi

resolve_runtime() {
  if [ -n "$runtime_path" ]; then
    command -v "$runtime_path" 2>/dev/null || { [ -x "$runtime_path" ] && printf '%s\n' "$runtime_path"; }
    return
  fi
  command -v node 2>/dev/null || command -v bun 2>/dev/null || true
}

resolve_codex() {
  if [ -n "$codex_path" ]; then
    command -v "$codex_path" 2>/dev/null || { [ -x "$codex_path" ] && printf '%s\n' "$codex_path"; }
    return
  fi
  command -v codex 2>/dev/null || true
}

runtime_path=$(resolve_runtime)
[ -n "$runtime_path" ] || { printf '%s\n' 'Node or Bun runtime not found. Pass --runtime.' >&2; exit 1; }
codex_path=$(resolve_codex)
[ -n "$codex_path" ] || { printf '%s\n' 'Codex executable not found. Pass --codex-bin or set AGORA_CODEX_BIN.' >&2; exit 1; }

if [ "$worker" = true ]; then
  export AGORA_ACTOR=$actor AGORA_CONFIG=$config_path AGORA_STATE=$state_root CODEX_SESSION_ID=$session_id
  unset AGORA_SESSION
  exec "$runtime_path" "$agora_path" watch "$room" --stream --follow --json --wake addressed \
    --codex-queue --codex-thread "$thread_id" --codex-bin "$codex_path" >>"$log_prefix.stdout.log" 2>>"$log_prefix.stderr.log"
fi

if command -v setsid >/dev/null 2>&1; then
  nohup setsid "$0" --worker --room "$room" --actor "$actor" --session-id "$session_id" --thread-id "$thread_id" \
    --config "$config_path" --state "$state_root" --runtime "$runtime_path" --codex-bin "$codex_path" \
    --log-prefix "$log_prefix" >/dev/null 2>&1 &
else
  nohup "$0" --worker --room "$room" --actor "$actor" --session-id "$session_id" --thread-id "$thread_id" \
    --config "$config_path" --state "$state_root" --runtime "$runtime_path" --codex-bin "$codex_path" \
    --log-prefix "$log_prefix" >/dev/null 2>&1 &
fi
supervisor_pid=$!

watcher_pid=
i=0
while [ "$i" -lt 100 ]; do
  watcher_pid=$(armed_pid)
  [ -n "$watcher_pid" ] && break
  kill -0 "$supervisor_pid" 2>/dev/null || break
  sleep 0.1
  i=$((i + 1))
done
if [ -z "$watcher_pid" ]; then
  kill "$supervisor_pid" 2>/dev/null || true
  printf '%s\n' "Codex watch did not arm within 10 seconds. Inspect $log_prefix.stderr.log." >&2
  exit 1
fi

printf '{"supervisorPid":%s,"watcherPid":%s,"room":"%s","actor":"%s","session":"%s","stdout":"%s","stderr":"%s"}\n' \
  "$supervisor_pid" "$watcher_pid" "$(json_string "$room")" "$(json_string "$actor")" \
  "$(json_string "$session_id")" "$(json_string "$log_prefix.stdout.log")" "$(json_string "$log_prefix.stderr.log")"
