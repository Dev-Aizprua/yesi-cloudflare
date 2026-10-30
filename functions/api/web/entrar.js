// functions/api/web/entrar.js
// GET  /api/web/entrar?c=...  → página con un botón "Entrar" (NO gasta el enlace: los previews y escáneres
//                               de enlaces hacen GET, pero no pulsan botones).
// POST /api/web/entrar        → canjea el enlace (una sola vez), deja la cookie de sesión.
import { canjearEnlace, cookieSesion } from '../../lib/accesoWeb.js';

const CABECERAS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

const pagina = (cuerpo, estado = 200) => new Response(
  `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Tu oficina</title>
<style>body{font:16px/1.5 system-ui,"Segoe UI",Roboto,sans-serif;background:#eef5fd;color:#14233b;display:grid;place-items:center;min-height:100dvh;margin:0;padding:16px}
.c{background:#fff;border-radius:20px;padding:28px 24px;max-width:380px;width:100%;text-align:center;box-shadow:0 2px 14px rgba(29,111,232,.1)}
h1{font-size:22px;margin:0 0 8px}p{color:#6b7c93;margin:0 0 18px}button{font:inherit;font-weight:600;background:#1d6fe8;color:#fff;border:0;border-radius:30px;padding:12px 28px;cursor:pointer}</style></head>
<body><div class="c">${cuerpo}</div></body></html>`,
  { status: estado, headers: { ...CABECERAS, 'Content-Type': 'text/html; charset=utf-8' } }
);

const MALO = '<h1>Este enlace ya no sirve</h1><p>Ya se usó o venció. Escríbele <b>mi oficina</b> al asistente por WhatsApp y te mando uno nuevo.</p>';

export async function onRequestGet({ request }) {
  const c = new URL(request.url).searchParams.get('c') || '';
  if (!/^[A-Za-z0-9_-]{30,64}$/.test(c)) return pagina(MALO, 410);
  return pagina(`<h1>Tu oficina</h1><p>Toca el botón para entrar.</p><button id="b">Entrar a mi oficina</button><p id="m" style="margin-top:14px"></p>
<script>
document.getElementById('b').onclick=async()=>{
  const b=document.getElementById('b');b.disabled=true;
  try{
    const r=await fetch('/api/web/entrar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({c:${JSON.stringify(c)}}),credentials:'same-origin'});
    if(r.ok){location.replace('/oficina.html');return}
  }catch(e){}
  document.getElementById('m').textContent='Este enlace ya no sirve. Pide uno nuevo por WhatsApp.';b.style.display='none';
};
</script>`);
}

export async function onRequestPost({ request, env }) {
  let c = '';
  try { c = String((await request.json())?.c ?? ''); } catch { /* cuerpo vacío */ }
  let r = null;
  try { r = await canjearEnlace(env.oficina_ia_db, c); } catch (e) { console.log('[WEB] Error canjeando enlace:', e.message); }
  if (!r) return new Response(JSON.stringify({ ok: false }), { status: 410, headers: { ...CABECERAS, 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...CABECERAS, 'Content-Type': 'application/json', 'Set-Cookie': cookieSesion(r.sesion) },
  });
}