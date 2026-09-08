#!/bin/sh
set -eu

room=
actor=
session_id=${CODEX_SESSION_ID:-${CODEX_THREAD_ID:-}}
thread_id=${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-}}
config_path=${AGORA_CONFIG:-${HOME}/.agora/config.json}
state_root=${AGORA_STATE:-${HOME}/.agora/state}
codex_home=${CODEX_HOME:-${HOME}/.codex}
runtime_path=
codex_path=${AGORA_CODEX_BIN:-}
log_prefix=
thread_interval=120
status=false
stop=false
force=false
worker=false
platform=$(uname -s 2>/dev/null || true)
launchd=false
launchd_label=
launchd_domain=
launchd_plist=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --room|-Room) room=$2; shift 2 ;;
    --actor|-Actor) actor=$2; shift 2 ;;
    --session-id|-SessionId) session_id=$2; shift 2 ;;
    --thread-id|-ThreadId) thread_id=$2; shift 2 ;;
    --config|-ConfigPath) config_path=$2; shift 2 ;;
    --state|-StateRoot) state_root=$2; shift 2 ;;
    --codex-home) codex_home=$2; shift 2 ;;
    --runtime|-RuntimePath|-BunPath) runtime_path=$2; shift 2 ;;
    --codex-bin|-CodexPath) codex_path=$2; shift 2 ;;
    --log-prefix|-LogPrefix) log_prefix=$2; shift 2 ;;
    --thread-interval|-ThreadInterval) thread_interval=$2; shift 2 ;;
    --status|-Status) status=true; shift ;;
    --stop|-Stop) stop=true; shift ;;
    --force|-Force) force=true; shift ;;
    --worker) worker=true; shift ;;
    *) printf '%s\n' "unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$thread_interval" in
  ''|*[!0-9]*) printf '%s\n' '--thread-interval must be a positive integer' >&2; exit 2 ;;
esac
[ "$thread_interval" -gt 0 ] || { printf '%s\n' '--thread-interval must be a positive integer' >&2; exit 2; }

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
if [ -z "$log_prefix" ]; then
  # Match the armed-record boundary: several sessions and rooms on one machine never share logs.
  safe_room=$(printf '%s' "$room" | sed 's/[^A-Za-z0-9._-]/_/g')
  log_prefix=${TMPDIR:-/tmp}/agora-codex-watch-$session_id-$safe_room
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
script_path=$script_dir/$(basename -- "$0")
launch_cwd=$(pwd -P)
agora_path=$(CDPATH= cd -- "$script_dir/../bin" && pwd)/agora.mjs
session_slug=codex-$session_id
armed_path=$state_root/sessions/$session_slug/armed/$room.json

if [ "$platform" = Darwin ]; then
  command -v launchctl >/dev/null 2>&1 || {
    printf '%s\n' 'launchctl is required to keep a Codex watch resident on macOS.' >&2
    exit 1
  }
  command -v plutil >/dev/null 2>&1 || {
    printf '%s\n' 'plutil is required to create the Codex watch LaunchAgent on macOS.' >&2
    exit 1
  }
  command -v shasum >/dev/null 2>&1 || {
    printf '%s\n' 'shasum is required to identify the Codex watch LaunchAgent on macOS.' >&2
    exit 1
  }
  launchd=true
  launchd_uid=$(id -u)
  if launchctl print "gui/$launchd_uid" >/dev/null 2>&1; then
    launchd_domain=gui/$launchd_uid
  else
    launchd_domain=user/$launchd_uid
  fi
  launchd_key=$(printf '%s\n%s' "$session_id" "$room" | shasum -a 256 | sed -n 's/^\([0-9a-f][0-9a-f]*\).*/\1/p')
  [ -n "$launchd_key" ] || { printf '%s\n' 'Could not derive the macOS LaunchAgent identity.' >&2; exit 1; }
  launchd_label=dev.agora.codex-watch.$launchd_key
  launchd_plist=$state_root/sessions/$session_slug/launchd/$launchd_label.plist
fi

armed_pid() {
  [ -f "$armed_path" ] || return 0
  sed -n 's/^[[:space:]]*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$armed_path" | head -n 1
}

launchd_loaded() {
  [ "$launchd" = true ] || return 1
  launchctl print "$launchd_domain/$launchd_label" >/dev/null 2>&1
}

launchd_pid() {
  [ "$launchd" = true ] || return 0
  launchctl print "$launchd_domain/$launchd_label" 2>/dev/null |
    sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' |
    head -n 1
}

wait_for_pid_exit() {
  [ -n "$1" ] || return 0
  wait_i=0
  while [ "$wait_i" -lt 50 ] && kill -0 "$1" 2>/dev/null; do
    sleep 0.1
    wait_i=$((wait_i + 1))
  done
}

stop_armed_watch() {
  stopped=false
  if launchd_loaded; then
    stop_pid=$service_pid
    launchctl bootout "$launchd_domain/$launchd_label" >/dev/null 2>&1 || return 1
    stopped=true
    wait_for_pid_exit "$stop_pid"
  elif [ "$alive" = true ]; then
    # Transition an older nohup-owned watcher cleanly after upgrading the launcher.
    kill "$pid" 2>/dev/null || true
    stopped=true
    wait_for_pid_exit "$pid"
  fi
  rm -f -- "$armed_path"
  if [ -n "$launchd_plist" ]; then rm -f -- "$launchd_plist"; fi
}

json_string() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

pid=$(armed_pid)
alive=false
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=true; fi
service_loaded=false
if launchd_loaded; then service_loaded=true; fi
service_pid=$(launchd_pid)
if [ "$service_loaded" = true ]; then supervisor_pid=$service_pid; else supervisor_pid=$pid; fi
if [ "$service_loaded" = true ]; then
  if [ -z "$service_pid" ] || [ "$service_pid" != "$pid" ]; then alive=false; fi
fi

if [ "$status" = true ]; then
  # A watch that ended for a transport reason wrote one watch-ended line to its stdout log; when
  # the armed pid is gone, that line is the reason, so --status carries it rather than leaving it
  # in a log nobody opens.
  ended=null
  if [ "$alive" = false ] && [ -f "$log_prefix.stdout.log" ]; then
    last_ended=$(grep '"type":"watch-ended"' "$log_prefix.stdout.log" 2>/dev/null | tail -n 1)
    if [ -n "$last_ended" ]; then ended=$last_ended; fi
  fi
  printf '{"room":"%s","session":"%s","watcherPid":%s,"supervisorPid":%s,"alive":%s,"armed":"%s","ended":%s}\n' \
    "$(json_string "$room")" "$(json_string "$session_id")" "${pid:-null}" "${supervisor_pid:-null}" "$alive" "$(json_string "$armed_path")" "$ended"
  exit 0
fi

if [ "$stop" = true ]; then
  stop_armed_watch || { printf '%s\n' "Could not stop macOS LaunchAgent $launchd_label." >&2; exit 1; }
  printf '{"room":"%s","session":"%s","stopped":%s,"watcherPid":%s,"supervisorPid":%s,"armed":"%s"}\n' \
    "$(json_string "$room")" "$(json_string "$session_id")" "$stopped" "${pid:-null}" "${supervisor_pid:-null}" "$(json_string "$armed_path")"
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
  stop_armed_watch || { printf '%s\n' "Could not replace macOS LaunchAgent $launchd_label." >&2; exit 1; }
fi
if [ "$worker" != true ] && launchd_loaded; then
  if [ "$force" != true ]; then
    printf '%s\n' "A macOS LaunchAgent already holds $room for this Codex session. Use --status, --stop, or --force." >&2
    exit 1
  fi
  stop_armed_watch || { printf '%s\n' "Could not replace macOS LaunchAgent $launchd_label." >&2; exit 1; }
fi
if [ "$worker" != true ] && [ "$alive" = false ] && [ -f "$armed_path" ]; then
  # Do not let the spawn loop mistake a dead record for the watcher being started now.
  rm -f -- "$armed_path"
fi
if [ "$worker" != true ]; then
  # A new arm starts a new stdout log. --status returns the last watch-ended line once the pid is
  # gone, and with an appended log that line could be an EARLIER arm's ending, handed to a task
  # whose current watch ended normally or was stopped on purpose.
  mkdir -p -- "$(dirname -- "$log_prefix")" && : >"$log_prefix.stdout.log"
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
  # The worker execs Node without changing pid, so this is the durable resident process on POSIX.
  export AGORA_ACTOR=$actor AGORA_CONFIG=$config_path AGORA_STATE=$state_root AGORA_SESSION_PID=$$ CODEX_HOME=$codex_home CODEX_SESSION_ID=$session_id
  unset AGORA_SESSION
  exec "$runtime_path" "$agora_path" watch "$room" --stream --follow --json --wake addressed \
    --thread-interval "$thread_interval" --coalesce 20 --codex-queue --codex-thread "$thread_id" --codex-bin "$codex_path" >>"$log_prefix.stdout.log" 2>>"$log_prefix.stderr.log"
fi

create_launchd_plist() {
  plist_dir=$(dirname -- "$launchd_plist")
  mkdir -p -- "$plist_dir"
  plist_tmp_dir=$plist_dir/.load-$$
  mkdir -- "$plist_tmp_dir"
  plist_load_path=$plist_tmp_dir/$launchd_label.plist
  rm -f -- "$plist_load_path"
  plutil -create xml1 "$plist_load_path"
  plutil -insert Label -string "$launchd_label" "$plist_load_path"
  plutil -insert ProgramArguments -array "$plist_load_path"
  plist_index=0
  for plist_value in \
    "$script_path" --worker --room "$room" --actor "$actor" --session-id "$session_id" \
    --thread-id "$thread_id" --config "$config_path" --state "$state_root" --runtime "$runtime_path" \
    --codex-home "$codex_home" --codex-bin "$codex_path" --log-prefix "$log_prefix" --thread-interval "$thread_interval"
  do
    plutil -insert "ProgramArguments.$plist_index" -string "$plist_value" "$plist_load_path"
    plist_index=$((plist_index + 1))
  done
  plutil -insert RunAtLoad -bool true "$plist_load_path"
  plutil -insert KeepAlive -bool false "$plist_load_path"
  plutil -insert ProcessType -string Background "$plist_load_path"
  plutil -insert WorkingDirectory -string "$launch_cwd" "$plist_load_path"
  plutil -insert StandardOutPath -string "$log_prefix.stdout.log" "$plist_load_path"
  plutil -insert StandardErrorPath -string "$log_prefix.stderr.log" "$plist_load_path"
}

if [ "$launchd" = true ]; then
  create_launchd_plist
  if ! launchctl bootstrap "$launchd_domain" "$plist_load_path"; then
    rm -f -- "$plist_load_path"
    rmdir -- "$plist_tmp_dir" 2>/dev/null || true
    if launchd_loaded; then
      printf '%s\n' "A macOS LaunchAgent already holds $room for this Codex session. Use --status, --stop, or --force." >&2
    else
      printf '%s\n' "Could not load macOS LaunchAgent $launchd_label." >&2
    fi
    exit 1
  fi
  mv -f -- "$plist_load_path" "$launchd_plist"
  rmdir -- "$plist_tmp_dir" 2>/dev/null || true
  supervisor_pid=
elif [ "$platform" = Linux ]; then
  command -v setsid >/dev/null 2>&1 || {
    printf '%s\n' 'setsid is required to keep a Codex watch resident on Linux.' >&2
    exit 1
  }
  command -v nohup >/dev/null 2>&1 || {
    printf '%s\n' 'nohup is required to keep a Codex watch resident on Linux.' >&2
    exit 1
  }
  nohup setsid "$script_path" --worker --room "$room" --actor "$actor" --session-id "$session_id" --thread-id "$thread_id" \
    --config "$config_path" --state "$state_root" --runtime "$runtime_path" --codex-bin "$codex_path" \
    --codex-home "$codex_home" --log-prefix "$log_prefix" --thread-interval "$thread_interval" >/dev/null 2>&1 &
  supervisor_pid=$!
else
  printf '%s\n' "Resident Codex watches are unsupported on platform '$platform'; supported platforms are Linux and macOS." >&2
  exit 1
fi

watcher_pid=
i=0
while [ "$i" -lt 100 ]; do
  watcher_pid=$(armed_pid)
  if [ -n "$watcher_pid" ] && kill -0 "$watcher_pid" 2>/dev/null; then
    if [ "$launchd" != true ] || [ "$(launchd_pid)" = "$watcher_pid" ]; then break; fi
  fi
  watcher_pid=
  if [ "$launchd" = true ]; then
    launchd_loaded || break
  else
    kill -0 "$supervisor_pid" 2>/dev/null || break
  fi
  sleep 0.1
  i=$((i + 1))
done
if [ -z "$watcher_pid" ]; then
  if [ "$launchd" = true ]; then
    launchctl bootout "$launchd_domain/$launchd_label" >/dev/null 2>&1 || true
    rm -f -- "$launchd_plist"
  else
    kill "$supervisor_pid" 2>/dev/null || true
  fi
  printf '%s\n' "Codex watch did not arm within 10 seconds. Inspect $log_prefix.stderr.log." >&2
  exit 1
fi
if [ "$launchd" = true ]; then supervisor_pid=$watcher_pid; fi

printf '{"supervisorPid":%s,"watcherPid":%s,"room":"%s","actor":"%s","session":"%s","stdout":"%s","stderr":"%s"}\n' \
  "$supervisor_pid" "$watcher_pid" "$(json_string "$room")" "$(json_string "$actor")" \
  "$(json_string "$session_id")" "$(json_string "$log_prefix.stdout.log")" "$(json_string "$log_prefix.stderr.log")"
