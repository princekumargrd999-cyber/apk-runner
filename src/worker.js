const PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>APK Runner</title>
<style>body{font:16px sans-serif;max-width:520px;margin:20px auto;padding:0 14px}
input,button{width:100%;padding:12px;margin:6px 0;font-size:16px;box-sizing:border-box}
iframe{width:100%;height:80vh;border:0;margin-top:10px}</style>
<h2>APK Runner</h2>
<input id=pw type=password placeholder="Password">
<input id=f type=file accept=".apk">
<button id=go>Upload &amp; Run</button>
<button id=stop>Stop auto-restart</button>
<p id=msg></p><div id=out></div>
<script>
const $=i=>document.getElementById(i),msg=t=>$('msg').textContent=t;
const H=()=>({'x-password':$('pw').value});
let shown='',iv=null;
$('pw').value=localStorage.getItem('pw')||'';
function poll(){
 clearInterval(iv);
 const tick=async()=>{
  const s=await fetch('/api/current',{headers:H()}); if(!s.ok) return;
  const c=await s.json(); if(!c.id) return;
  if(c.stopped) msg('Auto-restart band hai (current session khatam hone par ruk jayega)');
  if(!c.url){ if(!shown) msg('Emulator start ho raha hai, 3-5 minute...'); return; }
  const key=c.id+c.url; if(key===shown) return;
  const re=!!shown; shown=key; const u=c.url+'/?t='+c.token;
  msg(re?'Naya session shuru hua (app phir se install hui)':'Ready');
  $('out').innerHTML='<a href="'+u+'" target=_blank>Open full screen</a><iframe src="'+u+'"></iframe>';
 };
 tick(); iv=setInterval(tick,6000);
}
$('go').onclick=async()=>{
 const f=$('f').files[0]; if(!f) return msg('Select an APK');
 localStorage.setItem('pw',$('pw').value);
 const key=[...crypto.getRandomValues(new Uint8Array(12))].map(b=>b.toString(16).padStart(2,'0')).join('');
 const C=20*1024*1024, n=Math.ceil(f.size/C);
 if(n>10) return msg('APK bahut badi hai (max 200 MB)');
 let r;
 for(let i=0;i<n;i++){
  msg('Uploading '+(i+1)+'/'+n+'...');
  r=await fetch('/api/upload?key='+key+'&i='+i,{method:'PUT',headers:H(),body:f.slice(i*C,(i+1)*C)});
  if(!r.ok) return msg('Upload failed: '+await r.text());
 }
 r=await fetch('/api/upload?key='+key+'&done='+n,{method:'PUT',headers:H()});
 if(!r.ok) return msg('Upload failed: '+await r.text());
 r=await fetch('/api/start',{method:'POST',headers:{...H(),'content-type':'application/json'},body:JSON.stringify({key})});
 if(!r.ok) return msg('Start failed: '+await r.text());
 shown=''; $('out').innerHTML=''; poll();
};
$('stop').onclick=async()=>{
 const r=await fetch('/api/stop',{method:'POST',headers:H()}); msg(r.ok?'Auto-restart band kar diya':'Failed');
};
if($('pw').value) poll();
</script>`;

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const rid = () => [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, "0")).join("");
const MINUTES = "335"; // max for a GitHub-hosted job is 360 min including setup
const KEYRE = /^[0-9a-f]{24}$/;

const getState = async env => (await env.KV.get("state", "json")) || {};
const setState = (env, s) => env.KV.put("state", JSON.stringify(s));
const dispatch = (env, id, token, apk_key) =>
  fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/session.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, "User-Agent": "apk-runner", Accept: "application/vnd.github+json" },
    body: JSON.stringify({ ref: "main", inputs: { session_id: id, token, apk_key, minutes: MINUTES } }),
  });

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    const userOk = req.headers.get("x-password") === env.PASSWORD;
    const runnerOk = req.headers.get("authorization") === `Bearer ${env.CALLBACK_SECRET}`;
    const deny = () => new Response("unauthorized", { status: 401 });

    if (p === "/") return new Response(PAGE, { headers: { "content-type": "text/html;charset=utf-8" } });

    // APK is uploaded in 20 MB chunks (KV value limit is 25 MB)
    if (p === "/api/upload" && req.method === "PUT") {
      if (!userOk) return deny();
      const key = url.searchParams.get("key");
      if (!KEYRE.test(key || "")) return new Response("bad key", { status: 400 });
      const done = url.searchParams.get("done");
      if (done !== null) {
        const n = Number(done);
        if (!(n >= 1 && n <= 10)) return new Response("bad count", { status: 400 });
        await env.KV.put(`apk:${key}:n`, String(n));
        return json({ ok: true });
      }
      const i = Number(url.searchParams.get("i"));
      if (!(i >= 0 && i <= 9)) return new Response("bad index", { status: 400 });
      await env.KV.put(`apk:${key}:${i}`, await req.arrayBuffer());
      return json({ ok: true });
    }
    if (p === "/api/start" && req.method === "POST") {
      if (!userOk) return deny();
      const { key } = await req.json();
      if (!KEYRE.test(key || "")) return new Response("bad key", { status: 400 });
      const id = rid(), token = rid();
      const r = await dispatch(env, id, token, key);
      if (!r.ok) return new Response("github: " + (await r.text()), { status: 502 });
      await setState(env, { id, token, url: null, apk_key: key, stopped: false, next: null });
      return json({ id });
    }
    if (p === "/api/current") {
      if (!userOk) return deny();
      const s = await getState(env);
      return json({ id: s.id, token: s.token, url: s.url, stopped: !!s.stopped, nextPending: !!s.next });
    }
    if (p === "/api/stop" && req.method === "POST") {
      if (!userOk) return deny();
      const s = await getState(env); s.stopped = true; await setState(env, s);
      return json({ ok: true });
    }
    if (p === "/api/callback" && req.method === "POST") {
      if (!runnerOk) return deny();
      const { id, url: u } = await req.json();
      const s = await getState(env);
      if (s.next && s.next.id === id) { s.id = id; s.token = s.next.token; s.url = u; s.next = null; }
      else if (s.id === id) s.url = u;
      await setState(env, s);
      return json({ ok: true });
    }
    // Called by the running session shortly before it ends: start the same APK again.
    if (p === "/api/next" && req.method === "POST") {
      if (!runnerOk) return deny();
      const { id } = await req.json();
      const s = await getState(env);
      if (s.id !== id || s.stopped || !s.apk_key) return json({ skipped: true });
      const nid = rid(), ntoken = rid();
      const r = await dispatch(env, nid, ntoken, s.apk_key);
      if (!r.ok) return new Response("github: " + (await r.text()), { status: 502 });
      s.next = { id: nid, token: ntoken };
      await setState(env, s);
      return json({ started: nid });
    }
    // Runner downloads: /apk/<key>/n (chunk count) and /apk/<key>/<i>
    if (p.startsWith("/apk/")) {
      if (!runnerOk) return deny();
      const [, , key, part] = p.split("/");
      if (!KEYRE.test(key || "")) return new Response("bad key", { status: 400 });
      if (part === "n") {
        const n = await env.KV.get(`apk:${key}:n`);
        return n ? new Response(n) : new Response("missing", { status: 404 });
      }
      const b = await env.KV.get(`apk:${key}:${Number(part)}`, "arrayBuffer");
      return b ? new Response(b) : new Response("missing", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  },
};
