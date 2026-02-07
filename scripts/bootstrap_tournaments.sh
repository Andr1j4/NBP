#!/usr/bin/env bash
set -euo pipefail

API="http://192.168.0.2:8080"

PLAYERS=(
  "0e087985-98a7-48dd-b3db-7d7f9da87520"
  "1f6fa85d-9c47-4d7f-b33f-81f172a8c82a"
  "c1bb8a8d-06f5-42bd-af1a-0b619bce08c4"
  "f8017097-2cf4-4817-bef4-1b109e8ef880"
)

NAME="Test Tournament $(date +%F_%H-%M-%S)"

echo "[1/2] Creating tournament..."
CREATE_RES="$(curl -sS -X POST "$API/api/tournaments" \
  -H "Content-Type: application/json" \
  -d "$(printf '%s' "{
    \"name\": \"$NAME\",
    \"location\": \"Belgrade\",
    \"type\": \"round_robin\",
    \"time_control\": \"5+0\"
  }")")"

echo "[CREATE_RES] $CREATE_RES"

# ✅ Read JSON from stdin (robust)
TOURNAMENT_ID="$(
  printf '%s' "$CREATE_RES" | python3 -c '
import json,sys
obj=json.load(sys.stdin)
print(obj.get("tournamentId") or obj.get("id") or "")
'
)"

if [[ -z "$TOURNAMENT_ID" ]]; then
  echo "[ERROR] Could not parse tournamentId from create response"
  exit 1
fi

echo "Tournament created: $TOURNAMENT_ID"
echo
echo "[2/2] Registering players..."

for pid in "${PLAYERS[@]}"; do
  echo "Registering player $pid ..."
  RES="$(curl -sS -X POST "$API/api/tournaments/$TOURNAMENT_ID/register" \
    -H "Content-Type: application/json" \
    -d "{\"player_id\":\"$pid\"}")"
  echo "[REGISTER $pid] $RES"
done

echo
echo "Done. Tournament: $TOURNAMENT_ID"

