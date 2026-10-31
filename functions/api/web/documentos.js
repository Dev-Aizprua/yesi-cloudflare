// functions/api/web/documentos.js
// GET /api/web/documentos → historial de cartas generadas (SOLO LECTURA, sin descarga todavía).
import { sesionDeRequest } from '../../lib/accesoWeb.js';
import { resumenDocumentos } from '../../lib/datosNegocio.js';

const CABECERAS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const responder = (obj, estado = 200) => new Response(JSON.stringify(obj), { status: estado, headers: CABECERAS });

export async function onRequestGet({ request, env }) {
  let sesion = null;
  try { sesion = await sesionDeRequest(env.oficina_ia_db, request); } catch (e) { console.log('[WEB] documentos (sesión):', e.message); }
  if (!sesion) return responder({ ok: false }, 401);
  try {
    return responder({ ok: true, ...(await resumenDocumentos(env.oficina_ia_db, sesion.negocioId)) });
  } catch (e) {
    console.log('[WEB] documentos (datos):', e.message);
    return responder({ ok: false, error: 'No pude leer tus documentos. Intenta de nuevo en un momento.' }, 500);
  }
}