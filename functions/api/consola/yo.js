// functions/api/consola/yo.js
// GET /api/consola/yo → quién es el administrador de la sesión (sin datos sensibles).
import { sesionAdminDeRequest } from '../../lib/adminAuth.js';

const CABECERAS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export async function onRequestGet({ request, env }) {
  let s = null;
  try { s = await sesionAdminDeRequest(env.oficina_ia_db, request); } catch (e) { console.log('[CONSOLA] yo:', e?.message); }
  if (!s) return new Response(JSON.stringify({ ok: false }), { status: 401, headers: CABECERAS });
  return new Response(JSON.stringify({ ok: true, nombre: s.nombre, correo: s.correo }), { status: 200, headers: CABECERAS });
}