// functions/api/consola/datos.js
// GET /api/consola/datos?vista=inicio | suscriptores | detalle&id=N | planes → lecturas de la consola (solo administrador con sesión).
import { sesionAdminDeRequest } from '../../lib/adminAuth.js';
import { resumenInicio, listarSuscriptores, detalleSuscriptor, vistaPlanes } from '../../lib/consolaDatos.js';

const CAB = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const resp = (obj, estado = 200) => new Response(JSON.stringify(obj), { status: estado, headers: CAB });

export async function onRequestGet({ request, env }) {
  const db = env.oficina_ia_db;
  let s = null;
  try { s = await sesionAdminDeRequest(db, request); } catch (e) { console.log('[CONSOLA] datos sesión:', e?.message); }
  if (!s) return resp({ ok: false }, 401);
  const url = new URL(request.url);
  const vista = url.searchParams.get('vista');
  try {
    if (vista === 'inicio') return resp({ ok: true, ...(await resumenInicio(db)) });
    if (vista === 'suscriptores') return resp({ ok: true, suscriptores: await listarSuscriptores(db) });
    if (vista === 'planes') return resp({ ok: true, ...(await vistaPlanes(db)) });
    if (vista === 'detalle') {
      const id = Number(url.searchParams.get('id'));
      const d = await detalleSuscriptor(db, id);
      return d ? resp({ ok: true, negocio: d }) : resp({ ok: false, error: 'No existe ese negocio.' }, 404);
    }
  } catch (e) { console.log('[CONSOLA] datos:', e?.message); return resp({ ok: false, error: 'No se pudo leer la información.' }, 500); }
  return resp({ ok: false, error: 'Vista no válida.' }, 400);
}