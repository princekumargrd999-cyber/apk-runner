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
 msg('Uploading...');
 let r=await fetch('/api/upload',{method:'PUT',headers:H(),body:f});
 if(!r.ok) return msg('Upload failed: '+await r.text());
 const {key}=await r.json();
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

const getState = async env => { const o = await env.BUCKET.get("state/current.json"); return o ? await o.json() : {}; };
const setState = (env, s) => env.BUCKET.put("state/current.json", JSON.stringify(s));
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

    if (p === "/api/upload" && req.method === "PUT") {
      if (!userOk) return deny();
      const key = rid() + ".apk";
      await env.BUCKET.put("apk/" + key, req.body);
      return json({ key });
    }
    if (p === "/api/start" && req.method === "POST") {
      if (!userOk) return deny();
      const { key } = await req.json();
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
    if (p.startsWith("/apk/")) {
      if (!runnerOk) return deny();
      const o = await env.BUCKET.get("apk/" + p.slice(5));
      return o ? new Response(o.body) : new Response("missing", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  },
};
