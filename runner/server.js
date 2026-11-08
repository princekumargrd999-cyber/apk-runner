// Real-time screen streaming server.
//   scrcpy-server (H.264, on the emulator) --adb forward--> this file --WebSocket--> browser (WebCodecs)
// No PNG polling any more: the browser gets a live H.264 video + low-latency touch/keyboard input.
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { WebSocketServer } = require("ws");

const TOKEN = process.env.SESSION_TOKEN;
const JAR = process.env.SCRCPY_JAR || path.join(process.cwd(), "scrcpy-server.jar");
const VER = process.env.SCRCPY_VER || "3.1";          // must match the downloaded scrcpy-server version
const MAX_SIZE = process.env.MAX_SIZE || "960";        // longest side in px
const BITRATE = process.env.BITRATE || "3000000";      // 3 Mbps
const FPS = process.env.FPS || "30";
const FWD_PORT = 27183;
const MAX_BUFFERED = 512 * 1024;                       // if a client falls behind, drop frames until next keyframe
const PAGE = fs.readFileSync(path.join(__dirname, "viewer.html"));

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const adb = args => new Promise((res, rej) =>
  execFile("adb", args, { maxBuffer: 8e6 }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out))));

let ctl = null;          // scrcpy control socket (touch / keys / text)
let cfg = null;          // latest SPS+PPS (config packet)
let status = "starting emulator stream...";
const clients = new Set();

// ---------- control messages (scrcpy protocol) ----------
let lastIdr = 0;
function requestKeyframe() {
  const n = Date.now();
  if (!ctl || n - lastIdr < 700) return;
  lastIdr = n;
  ctl.write(Buffer.from([17])); // RESET_VIDEO -> encoder emits config + keyframe right away
}
function sendTouch(action, id, x, y, w, h) {
  if (!ctl || !(w > 0 && h > 0)) return;
  const b = Buffer.alloc(32);
  b[0] = 2; b[1] = action;                              // INJECT_TOUCH_EVENT, 0=down 1=up 2=move
  b.writeBigInt64BE(BigInt(id | 0), 2);                 // pointer id
  b.writeInt32BE(Math.min(Math.max(x | 0, 0), w - 1), 10);
  b.writeInt32BE(Math.min(Math.max(y | 0, 0), h - 1), 14);
  b.writeUInt16BE(w, 18); b.writeUInt16BE(h, 20);       // video size the coords refer to
  b.writeUInt16BE(action === 1 ? 0 : 0xffff, 22);       // pressure
  ctl.write(b);
}
function sendKey(code, repeatDown = true) {
  if (!ctl) return;
  for (const action of [0, 1]) {
    const b = Buffer.alloc(14);
    b[0] = 0; b[1] = action; b.writeInt32BE(code | 0, 2);
    ctl.write(b);
  }
}
function sendText(s) {
  if (!ctl || !s) return;
  const t = Buffer.from(String(s).slice(0, 300), "utf8");
  const b = Buffer.alloc(5 + t.length);
  b[0] = 1; b.writeUInt32BE(t.length, 1); t.copy(b, 5);
  ctl.write(b);
}

// ---------- video packets from scrcpy ----------
// packet = 8 bytes (pts + flags: bit63 config, bit62 keyframe) + 4 bytes size + payload (Annex-B H.264)
function onPacket(isConfig, isKey, data) {
  if (isConfig) { cfg = Buffer.from(data); return; }
  const out = Buffer.concat([Buffer.from([isKey ? 1 : 0]), ...(isKey && cfg ? [cfg] : []), data]);
  for (const c of clients) {
    if (c.ws.readyState !== 1) continue;
    if (c.needKey) { if (!isKey) continue; c.needKey = false; }
    else if (c.ws.bufferedAmount > MAX_BUFFERED) { c.needKey = true; requestKeyframe(); continue; }
    c.ws.send(out, { binary: true });
  }
}
function feedVideo(sock, first) {
  let buf = first;
  const eat = () => {
    while (buf.length >= 12) {
      const size = buf.readUInt32BE(8);
      if (buf.length < 12 + size) break;
      const flags = buf[0];
      const payload = buf.subarray(12, 12 + size);
      buf = buf.subarray(12 + size);
      onPacket(!!(flags & 0x80), !!(flags & 0x40), payload);
    }
  };
  eat();
  sock.on("data", d => { buf = buf.length ? Buffer.concat([buf, d]) : d; eat(); });
}

// ---------- start / supervise scrcpy ----------
function tryConnect(wantByte) {
  return new Promise(resolve => {
    const s = net.connect(FWD_PORT, "127.0.0.1");
    s.setNoDelay(true);
    let done = false;
    const fin = v => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => { s.destroy(); fin(null); }, 3000);
    s.on("error", () => fin(null));
    s.on("close", () => fin(null));
    if (wantByte) s.once("data", d => fin({ s, rest: d.subarray(1) })); // 1st byte = dummy byte of forward tunnel
    else s.once("connect", () => fin({ s }));
  });
}

async function session() {
  await adb(["push", JAR, "/data/local/tmp/scrcpy-server.jar"]);
  await adb(["forward", `tcp:${FWD_PORT}`, "localabstract:scrcpy"]);
  const opts = [
    `${VER}`, "log_level=info", "tunnel_forward=true", "video=true", "audio=false", "control=true",
    "send_device_meta=false", "send_frame_meta=true", "send_codec_meta=false",
    `max_size=${MAX_SIZE}`, `video_bit_rate=${BITRATE}`, `max_fps=${FPS}`, "video_codec=h264", "stay_awake=true",
  ].join(" ");
  const proc = spawn("adb", ["shell", `CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server ${opts}`]);
  proc.stdout.on("data", d => log("[scrcpy]", String(d).trim()));
  proc.stderr.on("data", d => log("[scrcpy]", String(d).trim()));
  const exited = new Promise(r => proc.on("exit", r));

  let video = null;
  for (let i = 0; i < 40 && !video; i++) { await sleep(500); video = await tryConnect(true); }
  if (!video) { proc.kill(); throw new Error("could not connect to scrcpy video socket"); }
  let control = null;
  for (let i = 0; i < 20 && !control; i++) control = await tryConnect(false);
  if (!control) { proc.kill(); video.s.destroy(); throw new Error("could not connect to scrcpy control socket"); }

  ctl = control.s;
  ctl.on("error", () => {}); ctl.on("data", () => {}); // ignore device->client messages
  status = "live";
  broadcastStatus();
  log("scrcpy connected");
  feedVideo(video.s, video.rest);
  await Promise.race([new Promise(r => video.s.on("close", r)), exited]);
  ctl && ctl.destroy(); ctl = null; video.s.destroy(); proc.kill();
}
async function supervise() {
  for (;;) {
    try { await session(); } catch (e) { log("session error:", e.message); }
    cfg = null; status = "reconnecting stream...";
    broadcastStatus();
    for (const c of clients) c.needKey = true;
    await sleep(1500);
  }
}
function broadcastStatus() {
  for (const c of clients) if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ status }));
}

// ---------- HTTP + WebSocket ----------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.searchParams.get("t") !== TOKEN) { res.writeHead(403); return res.end("no"); }
  if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(PAGE); }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on("upgrade", (req, sock, head) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname !== "/ws" || u.searchParams.get("t") !== TOKEN) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, ws => wss.emit("connection", ws));
});
wss.on("connection", ws => {
  const c = { ws, needKey: true };
  clients.add(c);
  ws.send(JSON.stringify({ status }));
  requestKeyframe();
  ws.on("message", (m, isBinary) => {
    if (isBinary) return;
    let j; try { j = JSON.parse(m.toString()); } catch { return; }
    if (j.t === "touch") sendTouch(j.a, j.id, j.x, j.y, j.w, j.h);
    else if (j.t === "key") sendKey(j.c);
    else if (j.t === "text") sendText(j.s);
    else if (j.t === "idr") { c.needKey = true; requestKeyframe(); }
  });
  ws.on("close", () => clients.delete(c));
  ws.on("error", () => clients.delete(c));
});
server.listen(8080, () => log("listening on 8080"));
supervise();
