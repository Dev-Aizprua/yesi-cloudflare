// functions/api/web/yo.js
// GET /api/web/yo → quién está dentro (según la cookie de sesión). Nunca devuelve credenciales del negocio.
import { sesionDeRequest } from '../../lib/accesoWeb.js';

const CABECERAS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export async function onRequestGet({ request, env }) {
  let sesion = null;
  try { sesion = await sesionDeRequest(env.oficina_ia_db, request); } catch (e) { console.log('[WEB] yo:', e.message); }
  if (!sesion) return new Response(JSON.stringify({ ok: false }), { status: 401, headers: CABECERAS });
  const fila = await env.oficina_ia_db.prepare(
    `SELECT n.nombre AS nombre, c.nombre_comercial AS comercial
       FROM negocios n LEFT JOIN configuracion_negocio c ON c.negocio_id = n.id WHERE n.id = ?`
  ).bind(sesion.negocioId).first();
  return new Response(JSON.stringify({ ok: true, negocio: fila?.comercial || fila?.nombre || '' }), { status: 200, headers: CABECERAS });
}