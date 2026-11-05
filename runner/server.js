// Tiny screen-streaming server (no dependencies). Frames via adb screencap, input via adb.
const http = require("http");
const { execFile } = require("child_process");
const TOKEN = process.env.SESSION_TOKEN;
const adb = (args, buf) => new Promise((res, rej) =>
  execFile("adb", args, { encoding: buf ? "buffer" : "utf8", maxBuffer: 64e6 },
    (e, out) => (e ? rej(e) : res(out))));
let W = 540, H = 960;
adb(["shell", "wm", "size"]).then(o => {
  const m = /(\d+)x(\d+)\s*$/.exec(o.trim()); if (m) { W = +m[1]; H = +m[2]; }
}).catch(() => {});

const PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#111;color:#fff;font:14px sans-serif;text-align:center}
img{max-height:88vh;max-width:100%;touch-action:none;user-select:none}
button{padding:10px 16px;margin:4px;font-size:15px}</style>
<img id=s>
<div><button onclick="k(4)">Back</button><button onclick="k(3)">Home</button><button onclick="k(187)">Recent</button></div>
<script>
const t=new URLSearchParams(location.search).get('t'),q='?t='+t,s=document.getElementById('s');
let busy=false;
async function loop(){ if(!busy){busy=true;try{const r=await fetch('/frame'+q+'&_='+Date.now());
 if(r.ok){const u=URL.createObjectURL(await r.blob());const o=s.src;s.src=u;o&&URL.revokeObjectURL(o);}}catch(e){}busy=false;}
 setTimeout(loop,150);}
loop();
let d=null;
s.addEventListener('pointerdown',e=>{d={x:e.clientX,y:e.clientY,t:Date.now()};e.preventDefault()});
s.addEventListener('pointerup',e=>{if(!d)return;const r=s.getBoundingClientRect(),f=(x,y)=>[(x-r.left)/r.width,(y-r.top)/r.height];
 const a=f(d.x,d.y),b=f(e.clientX,e.clientY),ms=Math.max(100,Date.now()-d.t);d=null;
 fetch('/swipe'+q+'&a='+a+'&b='+b+'&ms='+ms,{method:'POST'});});
function k(c){fetch('/key'+q+'&c='+c,{method:'POST'})}
</script>`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.searchParams.get("t") !== TOKEN) { res.writeHead(403); return res.end("no"); }
  try {
    if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(PAGE); }
    if (u.pathname === "/frame") {
      const png = await adb(["exec-out", "screencap", "-p"], true);
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }); return res.end(png);
    }
    if (u.pathname === "/swipe") {
      const [x1, y1] = u.searchParams.get("a").split(",").map(Number);
      const [x2, y2] = u.searchParams.get("b").split(",").map(Number);
      const ms = Math.min(+u.searchParams.get("ms") || 100, 1500);
      const p = (v, m) => String(Math.round(Math.min(Math.max(v, 0), 1) * m));
      const moved = Math.hypot(x2 - x1, y2 - y1) > 0.02;
      await adb(moved
        ? ["shell", "input", "swipe", p(x1, W), p(y1, H), p(x2, W), p(y2, H), String(ms)]
        : ["shell", "input", "tap", p(x1, W), p(y1, H)]);
      return res.end("ok");
    }
    if (u.pathname === "/key") {
      await adb(["shell", "input", "keyevent", String(+u.searchParams.get("c"))]); return res.end("ok");
    }
    res.writeHead(404); res.end();
  } catch (e) { res.writeHead(500); res.end(String(e)); }
}).listen(8080);
