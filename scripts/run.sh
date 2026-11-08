#!/usr/bin/env bash
set -u
adb shell wm size 540x960
adb shell wm density 240
adb install -r -t app.apk || echo "install failed"
SESSION_TOKEN="$SESSION_TOKEN" SCRCPY_JAR="$PWD/scrcpy-server.jar" node runner/server.js > server.log 2>&1 &
cloudflared tunnel --url http://localhost:8080 --no-autoupdate > tunnel.log 2>&1 &
URL=""
for i in $(seq 1 40); do
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' tunnel.log | head -1)
  [ -n "$URL" ] && break
  sleep 3
done
post() {
  curl -fsS -X POST "$WORKER_URL$1" \
    -H "Authorization: Bearer $CALLBACK_SECRET" -H "content-type: application/json" -d "$2"
}
post /api/callback "{\"id\":\"$SESSION_ID\",\"url\":\"$URL\"}"
# Auto-restart: start the next session 8 min before this one ends (boot takes ~5 min),
# so the same APK is running again right when this session closes.
LEAD=8
sleep $(( (MINUTES - LEAD) * 60 ))
post /api/next "{\"id\":\"$SESSION_ID\"}" || true
sleep $(( LEAD * 60 ))
