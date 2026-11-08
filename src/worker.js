const PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>APK Runner</title>
<style>body{font:16px sans-serif;max-width:520px;margin:20px auto;padding:0 14px}
input,button{width:100%;padding:12px;margin:6px 0;font-size:16px;box-sizing:border-box}
iframe{width:100%;height:80vh;border:0;margin-top:10px}</style>
<h2>APK Runner</h2>
<input id=pw type=password placeholder="Password">
<input id=f type=file accept=".apk">
<input id=u type=url placeholder="Ya APK ka direct link (https://...)" autocomplete=off>
<p id=info></p>
<progress id=bar max=100 value=0 style="width:100%;display:none"></progress>
<button id=go>Upload &amp; Run</button>
<button id=stop>Cancel / Stop</button>
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
  if(c.error){msg('Error: '+c.error);return;}
  if(!c.url){ if(!shown) msg('Emulator start ho raha hai, 3-5 minute...'); return; }
  const key=c.id+c.url; if(key===shown) return;
  const re=!!shown; shown=key; const u=c.url+'/?t='+c.token;
  msg(re?'Naya session shuru hua (app phir se install hui)':'Ready');
  $('out').innerHTML='<a href="'+u+'" target=_blank>Open full screen</a><iframe src="'+u+'"></iframe>';
 };
 tick(); iv=setInterval(tick,6000);
}
let curX=null,uploading=false,aborted=false;
const mb=b=>(b/1048576).toFixed(1)+' MB';
$('f').onchange=()=>{const f=$('f').files[0];$('info').textContent=f?f.name+' - '+mb(f.size):'';};
function put(url,body,onp){return new Promise(res=>{const x=new XMLHttpRequest();curX=x;x.open('PUT',url);
 const h=H();for(const k in h)x.setRequestHeader(k,h[k]);
 x.upload.onprogress=e=>onp&&onp(e.loaded);
 x.onload=()=>res({ok:x.status<300,text:x.responseText});
 x.onerror=()=>res({ok:false,text:'network error'});x.onabort=()=>res({ok:false,text:'cancelled'});x.send(body);});}
async function doUpload(){
 const f=$('f').files[0],link=$('u').value.trim();
 if(!f&&!link) return msg('APK select karo ya link daalo');
 localStorage.setItem('pw',$('pw').value);
 if(!f){
  msg('Link se APK download hone ke liye session start ho raha hai...');
  const r0=await fetch('/api/start',{method:'POST',headers:{...H(),'content-type':'application/json'},body:JSON.stringify({url:link})});
  if(!r0.ok) return msg('Start failed: '+await r0.text());
  shown=''; $('out').innerHTML=''; poll(); return;
 }
 const key=[...crypto.getRandomValues(new Uint8Array(12))].map(b=>b.toString(16).padStart(2,'0')).join('');
 const C=20*1024*1024, n=Math.ceil(f.size/C);
 if(n>10) return msg('APK bahut badi hai (max 200 MB)');
 const bar=$('bar'); bar.style.display='block'; bar.value=0;
 let sent=0,r;const t0=Date.now();
 for(let i=0;i<n;i++){
  const chunk=f.slice(i*C,(i+1)*C);
  r=await put('/api/upload?key='+key+'&i='+i,chunk,l=>{
   const t=sent+l,pc=Math.min(100,Math.round(t/f.size*100));
   bar.value=pc;
   const sec=Math.max((Date.now()-t0)/1000,0.2),sp=t/sec,eta=Math.max(0,Math.round((f.size-t)/sp));
   msg('Uploading '+pc+'% ('+mb(t)+' / '+mb(f.size)+') | Speed: '+mb(sp)+'/s ('+(sp*8/1e6).toFixed(1)+' Mbps) | Baaki: '+eta+' sec');});
  if(aborted){bar.style.display='none';return msg('Upload cancel kiya');}
  if(!r.ok) return msg('Upload failed: '+r.text);
  sent+=chunk.size;
 }
 r=await put('/api/upload?key='+key+'&done='+n,null);
 if(!r.ok) return msg('Upload failed: '+r.text);
 bar.value=100; msg('Upload 100% ('+mb(f.size)+'). Session start ho raha hai...');
 r=await fetch('/api/start',{method:'POST',headers:{...H(),'content-type':'application/json'},body:JSON.stringify({key})});
 if(!r.ok) return msg('Start failed: '+await r.text());
 shown=''; $('out').innerHTML=''; poll();
}
$('go').onclick=async()=>{uploading=true;aborted=false;try{await doUpload();}finally{uploading=false;}};
$('stop').onclick=async()=>{
 if(uploading){aborted=true;if(curX)curX.abort();return;}
 msg('Cancel ho raha hai...');
 const r=await fetch('/api/stop',{method:'POST',headers:H()});
 shown=''; $('out').innerHTML=''; $('bar').style.display='none';
 msg(r.ok?'Cancel ho gaya: chalta session aur auto-restart dono band':'Cancel failed');
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
      const body = await req.json();
      let key = body.key;
      if (body.url) {
        // APK is fetched by the GitHub runner straight from this link (kept private in KV, not in workflow inputs)
        const link = String(body.url).trim();
        let u; try { u = new URL(link); } catch (e) { return new Response("bad url", { status: 400 }); }
        if (!/^https?:$/.test(u.protocol) || link.length > 2000) return new Response("bad url", { status: 400 });
        key = rid();
        await env.KV.put(`apk:${key}:url`, link);
      }
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
      return json({ id: s.id, token: s.token, url: s.url, error: s.error || null, stopped: !!s.stopped, nextPending: !!s.next });
    }
    if (p === "/api/stop" && req.method === "POST") {
      if (!userOk) return deny();
      const s = await getState(env);
      await setState(env, { apk_key: s.apk_key, stopped: true });
      // cancel any running or queued session on GitHub
      for (const st of ["in_progress", "queued"]) {
        try {
          const gh = { Authorization: `Bearer ${env.GH_TOKEN}`, "User-Agent": "apk-runner", Accept: "application/vnd.github+json" };
          const lr = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/session.yml/runs?status=${st}`, { headers: gh });
          const runs = (await lr.json()).workflow_runs || [];
          for (const r of runs) await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/runs/${r.id}/cancel`, { method: "POST", headers: gh });
        } catch (e) {}
      }
      return json({ ok: true });
    }
    if (p === "/api/callback" && req.method === "POST") {
      if (!runnerOk) return deny();
      const { id, url: u, error } = await req.json();
      const s = await getState(env);
      if (error) { if (s.id === id) { s.error = String(error).slice(0, 200); await setState(env, s); } return json({ ok: true }); }
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
      if (part === "url") {
        const l = await env.KV.get(`apk:${key}:url`);
        return l ? new Response(l) : new Response("missing", { status: 404 });
      }
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
