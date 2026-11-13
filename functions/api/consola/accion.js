// functions/api/consola/accion.js
// POST /api/consola/accion {accion, negocio_id, ...} → cambios sobre una suscripción (solo administrador con sesión).
// acciones: alta | pago | suspender | reactivar | cancelar | cambiar_plan | enlace_acceso
import { sesionAdminDeRequest, rechazoDePeticion } from '../../lib/adminAuth.js';
import { crearEnlaceAcceso, MINUTOS_ENLACE } from '../../lib/accesoWeb.js';
import { auditar, altaSuscripcion, registrarPagoSuscripcion, suspenderSuscripcion, reactivarSuscripcion, cancelarSuscripcion, cambiarPlanSuscripcion, montoACentavos } from '../../lib/suscripcion.js';

const CAB = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const resp = (obj, estado = 200) => new Response(JSON.stringify(obj), { status: estado, headers: CAB });
const texto = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export async function onRequestPost({ request, env }) {
  const malo = rechazoDePeticion(request);
  if (malo) return resp({ ok: false, error: 'Petición no válida.' }, malo);
  const db = env.oficina_ia_db;
  let s = null;
  try { s = await sesionAdminDeRequest(db, request); } catch (e) { console.log('[CONSOLA] accion sesión:', e?.message); }
  if (!s) return resp({ ok: false }, 401);
  let c = null;
  try { c = await request.json(); } catch { return resp({ ok: false, error: 'Petición no válida.' }, 400); }
  const negocioId = Number(c?.negocio_id);
  if (!c || typeof c.accion !== 'string' || !Number.isInteger(negocioId) || negocioId <= 0) return resp({ ok: false, error: 'Petición no válida.' }, 400);
  const adminId = s.adminId;
  try {
    let r;
    switch (c.accion) {
      case 'alta': r = await altaSuscripcion(db, { negocioId, planId: Number(c.plan_id), adminId }); break;
      case 'pago': {
        const monto = montoACentavos(c.monto);
        if (monto === null) return resp({ ok: false, error: 'El monto no es válido.' }, 400);
        r = await registrarPagoSuscripcion(db, { negocioId, montoCentavos: monto, metodo: texto(c.metodo, 20), referencia: texto(c.referencia, 80) || null, fecha: texto(c.fecha, 10) || null, adminId });
        break;
      }
      case 'suspender': r = await suspenderSuscripcion(db, { negocioId, motivo: texto(c.motivo, 200) || null, adminId }); break;
      case 'reactivar': r = await reactivarSuscripcion(db, { negocioId, adminId }); break;
      case 'cancelar': r = await cancelarSuscripcion(db, { negocioId, motivo: texto(c.motivo, 200) || null, adminId }); break;
      case 'cambiar_plan': r = await cambiarPlanSuscripcion(db, { negocioId, planId: Number(c.plan_id), adminId }); break;
      case 'enlace_acceso': { // enlace de un solo uso para que el dueño entre a "Mi oficina" sin depender de WhatsApp
        const neg = await db.prepare('SELECT id, nombre FROM negocios WHERE id = ?').bind(negocioId).first();
        if (!neg) return resp({ ok: false, error: 'Ese negocio no existe.' }, 404);
        const url = await crearEnlaceAcceso(db, negocioId, new URL(request.url).origin);
        await auditar(db, adminId, 'enlace_acceso_generado', 'negocio', negocioId, { nombre: neg.nombre }); // nunca se guarda el enlace
        return resp({ ok: true, url, minutos: MINUTOS_ENLACE });
      }
      default: return resp({ ok: false, error: 'Acción no válida.' }, 400);
    }
    return resp(r, r.ok ? 200 : 400);
  } catch (e) { console.log('[CONSOLA] accion:', e?.message); return resp({ ok: false, error: 'No se pudo completar la acción.' }, 500); }
}