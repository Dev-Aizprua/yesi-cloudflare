// functions/api/web/cuadros.js
// GET /api/web/cuadros          → lista de cuadros del negocio
// GET /api/web/cuadros?id=N     → un cuadro (tabla con totales) — SOLO LECTURA
import { sesionDeRequest } from '../../lib/accesoWeb.js';
import { listarCuadros, cargarCuadro, vistaCuadro } from '../../lib/cuadrosWeb.js';

const CABECERAS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const responder = (obj, estado = 200) => new Response(JSON.stringify(obj), { status: estado, headers: CABECERAS });

export async function onRequestGet({ request, env }) {
  let sesion = null;
  try { sesion = await sesionDeRequest(env.oficina_ia_db, request); } catch (e) { console.log('[WEB] cuadros (sesión):', e.message); }
  if (!sesion) return responder({ ok: false }, 401);
  const id = new URL(request.url).searchParams.get('id');
  try {
    if (id === null) return responder({ ok: true, cuadros: await listarCuadros(env.oficina_ia_db, sesion.negocioId) });
    const c = await cargarCuadro(env.oficina_ia_db, sesion.negocioId, id);
    if (!c) return responder({ ok: false, error: 'Ese cuadro no existe.' }, 404);
    return responder({ ok: true, cuadro: vistaCuadro(c) });
  } catch (e) {
    console.log('[WEB] cuadros (datos):', e.message);
    return responder({ ok: false, error: 'No pude leer los cuadros. Intenta de nuevo en un momento.' }, 500);
  }
}