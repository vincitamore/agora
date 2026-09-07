#!/bin/sh
exec node "$(dirname "$0")/fake-codex-app-server.mjs" "$@"
