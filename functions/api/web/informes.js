// functions/api/web/informes.js
// GET /api/web/informes?rango=mes|mes_pasado|3meses|personalizado[&desde=YYYY-MM-DD&hasta=YYYY-MM-DD] (SOLO LECTURA).
import { sesionDeRequest } from '../../lib/accesoWeb.js';
import { resumenInforme } from '../../lib/datosNegocio.js';

const CABECERAS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const responder = (obj, estado = 200) => new Response(JSON.stringify(obj), { status: estado, headers: CABECERAS });

export async function onRequestGet({ request, env }) {
  let sesion = null;
  try { sesion = await sesionDeRequest(env.oficina_ia_db, request); } catch (e) { console.log('[WEB] informes (sesión):', e.message); }
  if (!sesion) return responder({ ok: false }, 401);
  const q = new URL(request.url).searchParams;
  try {
    const r = await resumenInforme(env.oficina_ia_db, sesion.negocioId, { rango: q.get('rango') || 'mes', desde: q.get('desde'), hasta: q.get('hasta') });
    if (r.error) return responder({ ok: false, error: r.error }, 400);
    return responder({ ok: true, ...r });
  } catch (e) {
    console.log('[WEB] informes (datos):', e.message);
    return responder({ ok: false, error: 'No pude armar el informe. Intenta de nuevo en un momento.' }, 500);
  }
}