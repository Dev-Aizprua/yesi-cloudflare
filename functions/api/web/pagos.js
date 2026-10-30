// functions/api/web/pagos.js
// GET /api/web/pagos → clientes con lo que deben, saldo a favor y pagos recientes (SOLO LECTURA).
import { sesionDeRequest } from '../../lib/accesoWeb.js';
import { resumenPagos } from '../../lib/datosNegocio.js';

const CABECERAS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const responder = (obj, estado = 200) => new Response(JSON.stringify(obj), { status: estado, headers: CABECERAS });

export async function onRequestGet({ request, env }) {
  let sesion = null;
  try { sesion = await sesionDeRequest(env.oficina_ia_db, request); } catch (e) { console.log('[WEB] pagos (sesión):', e.message); }
  if (!sesion) return responder({ ok: false }, 401);
  try {
    return responder({ ok: true, ...(await resumenPagos(env.oficina_ia_db, sesion.negocioId)) });
  } catch (e) {
    console.log('[WEB] pagos (datos):', e.message);
    return responder({ ok: false, error: 'No pude leer los pagos. Intenta de nuevo en un momento.' }, 500);
  }
}