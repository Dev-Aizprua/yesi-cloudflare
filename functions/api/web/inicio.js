// functions/api/web/inicio.js
// GET /api/web/inicio → cifras del Inicio (SOLO LECTURA). El negocio sale de la sesión, nunca del navegador.
import { sesionDeRequest } from '../../lib/accesoWeb.js';
import { resumenInicio } from '../../lib/datosNegocio.js';

const CABECERAS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const responder = (obj, estado = 200) => new Response(JSON.stringify(obj), { status: estado, headers: CABECERAS });

export async function onRequestGet({ request, env }) {
  let sesion = null;
  try { sesion = await sesionDeRequest(env.oficina_ia_db, request); } catch (e) { console.log('[WEB] inicio (sesión):', e.message); }
  if (!sesion) return responder({ ok: false }, 401);
  try {
    return responder({ ok: true, ...(await resumenInicio(env.oficina_ia_db, sesion.negocioId)) });
  } catch (e) {
    console.log('[WEB] inicio (datos):', e.message);
    return responder({ ok: false, error: 'No pude leer los datos del negocio. Intenta de nuevo en un momento.' }, 500);
  }
}