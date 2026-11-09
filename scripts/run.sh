#!/usr/bin/env bash
set -u
# Device resolution: 720x1280 = sharper picture. If the emulator feels slow, use 540x960 + density 240.
adb shell wm size ${DEV_SIZE:-720x1280}
adb shell wm density ${DEV_DENSITY:-320}
# Keep the screen awake: a sleeping emulator screen = frozen/black stream.
adb shell settings put global stay_on_while_plugged_in 7
adb shell settings put system screen_off_timeout 2147483647
adb shell svc power stayon true
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
adb install -r -t app.apk || echo "install failed"
# server output goes to the Actions log (no secrets in it) so problems are visible there
SESSION_TOKEN="$SESSION_TOKEN" SCRCPY_JAR="$PWD/scrcpy-server.jar" node runner/server.js &
URL=""; TPID=""
start_tunnel() {
  [ -n "$TPID" ] && kill "$TPID" 2>/dev/null
  : > tunnel.log
  cloudflared tunnel --url http://localhost:8080 --no-autoupdate --protocol http2 > tunnel.log 2>&1 &
  TPID=$!
  URL=""
  for i in $(seq 1 40); do
    URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' tunnel.log | head -1)
    [ -n "$URL" ] && break
    sleep 3
  done
}
start_tunnel
post() {
  curl -fsS -X POST "$WORKER_URL$1" \
    -H "Authorization: Bearer $CALLBACK_SECRET" -H "content-type: application/json" -d "$2"
}
post /api/callback "{\"id\":\"$SESSION_ID\",\"url\":\"$URL\"}"
# Tunnel watchdog: if the public URL stops answering 3x in a row (or cloudflared dies), restart the tunnel
# and tell the Worker the new URL (the page picks it up within ~6s).
(
  BAD=0
  while true; do
    sleep 20
    CODE=$(curl -s -o /dev/null -m 10 -w "%{http_code}" "$URL/?t=$SESSION_TOKEN")
    if [ "$CODE" = "200" ] && kill -0 "$TPID" 2>/dev/null; then BAD=0; else BAD=$((BAD+1)); echo "tunnel check failed ($CODE) $BAD/3"; fi
    if [ "$BAD" -ge 3 ]; then
      echo "restarting tunnel"; BAD=0; start_tunnel
      [ -n "$URL" ] && post /api/callback "{\"id\":\"$SESSION_ID\",\"url\":\"$URL\"}" || true
    fi
  done
) &
# Auto-restart: start the next session 8 min before this one ends (boot takes ~5 min),
# so the same APK is running again right when this session closes.
LEAD=8
sleep $(( (MINUTES - LEAD) * 60 ))
post /api/next "{\"id\":\"$SESSION_ID\"}" || true
sleep $(( LEAD * 60 ))
