// functions/api/consola/pagos.js
// POST /api/consola/pagos {accion:'anular', pago_id, motivo} → anula un pago registrado por error (solo administrador con sesión).
import { sesionAdminDeRequest, rechazoDePeticion } from '../../lib/adminAuth.js';
import { anularPagoSuscripcion } from '../../lib/suscripcion.js';

const CAB = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const resp = (obj, estado = 200) => new Response(JSON.stringify(obj), { status: estado, headers: CAB });

export async function onRequestPost({ request, env }) {
  const malo = rechazoDePeticion(request);
  if (malo) return resp({ ok: false, error: 'Petición no válida.' }, malo);
  const db = env.oficina_ia_db;
  let s = null;
  try { s = await sesionAdminDeRequest(db, request); } catch (e) { console.log('[CONSOLA] pagos sesión:', e?.message); }
  if (!s) return resp({ ok: false }, 401);
  let c = null;
  try { c = await request.json(); } catch { return resp({ ok: false, error: 'Petición no válida.' }, 400); }
  const pagoId = Number(c?.pago_id);
  if (!c || c.accion !== 'anular' || !Number.isInteger(pagoId) || pagoId <= 0 || typeof c.motivo !== 'string') return resp({ ok: false, error: 'Petición no válida.' }, 400);
  try {
    const r = await anularPagoSuscripcion(db, { pagoId, motivo: c.motivo, adminId: s.adminId });
    return resp(r, r.ok ? 200 : 400);
  } catch (e) { console.log('[CONSOLA] pagos:', e?.message); return resp({ ok: false, error: 'No se pudo completar la acción.' }, 500); }
}