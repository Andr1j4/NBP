#!/usr/bin/env bash
set -euo pipefail
# set -x

API_BASE="${API_BASE:-http://192.168.0.2:8080}"

# ---- Players you gave earlier ----
PLAYERS=(
  "0e087985-98a7-48dd-b3db-7d7f9da87520"
  "1f6fa85d-9c47-4d7f-b33f-81f172a8c82a"
  "c1bb8a8d-06f5-42bd-af1a-0b619bce08c4"
  "f8017097-2cf4-4817-bef4-1b109e8ef880"
)

# ---- Tournament create payload (adjust fields if your API expects different) ----
NAME="${1:-Auto Tournament $(date '+%Y-%m-%d %H:%M:%S')}"
TYPE="${TYPE:-single_elim}"
TIME_CONTROL="${TIME_CONTROL:-5+0}"
LOCATION="${LOCATION:-Online}"

echo "[1/2] Creating tournament..."
CREATE_RES="$(
  curl -sS -X POST "${API_BASE}/api/tournaments" \
    -H "Content-Type: application/json" \
    -d "{
      \"name\": \"${NAME}\",
      \"type\": \"${TYPE}\",
      \"time_control\": \"${TIME_CONTROL}\",
      \"location\": \"${LOCATION}\"
    }"
)"

echo "Create response: ${CREATE_RES}"

# Try common keys: tournamentId, tournament_id, id
TOURNAMENT_ID="$(
  echo "$CREATE_RES" | sed -nE 's/.*"tournamentId"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p'
)"
if [[ -z "${TOURNAMENT_ID}" ]]; then
  TOURNAMENT_ID="$(
    echo "$CREATE_RES" | sed -nE 's/.*"tournament_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p'
  )"
fi
if [[ -z "${TOURNAMENT_ID}" ]]; then
  TOURNAMENT_ID="$(
    echo "$CREATE_RES" | sed -nE 's/.*"id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p'
  )"
fi

if [[ -z "${TOURNAMENT_ID}" ]]; then
  echo "ERROR: Could not extract tournament id from create response."
  echo "Adjust the parser or print your create response shape."
  exit 1
fi

echo "✅ Tournament created: ${TOURNAMENT_ID}"
echo

echo "[2/2] Joining players..."
for pid in "${PLAYERS[@]}"; do
  echo " - adding player_id=${pid}"
  curl -sS -X POST "${API_BASE}/api/tournaments/${TOURNAMENT_ID}/register" \
    -H "Content-Type: application/json" \
    -d "{\"player_id\":\"${pid}\"}" \
    | cat
  echo
done

echo "✅ Done."
echo "Tournament ID: ${TOURNAMENT_ID}"

