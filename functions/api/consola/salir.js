// functions/api/consola/salir.js
// POST /api/consola/salir → cierra la sesión del administrador (borra la sesión y la cookie).
import { cerrarSesionAdmin, cookieAdmin, rechazoDePeticion } from '../../lib/adminAuth.js';

const CABECERAS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export async function onRequestPost({ request, env }) {
  const malo = rechazoDePeticion(request);
  if (malo) return new Response(JSON.stringify({ ok: false }), { status: malo, headers: CABECERAS });
  try { await cerrarSesionAdmin(env.oficina_ia_db, request); } catch (e) { console.log('[CONSOLA] salir:', e?.message); }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...CABECERAS, 'Set-Cookie': cookieAdmin('', 0) } });
}