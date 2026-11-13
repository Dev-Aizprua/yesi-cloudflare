// functions/api/consola/planes.js
// POST /api/consola/planes {accion, ...} → planes, precios y reglas de vencimiento (solo administrador con sesión).
// acciones: vista_previa | precio | limites | crear | activo | gracia
import { sesionAdminDeRequest, rechazoDePeticion } from '../../lib/adminAuth.js';
import { vistaPreviaCambioPrecio, cambiarPrecioPlan, actualizarLimitesPlan, crearPlan, cambiarEstadoPlan, guardarAjuste, montoACentavos } from '../../lib/suscripcion.js';

const CAB = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const resp = (obj, estado = 200) => new Response(JSON.stringify(obj), { status: estado, headers: CAB });
// Tope vacío = sin tope (null). Algo que no sea número entero devuelve undefined (inválido).
const tope = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : undefined));

export async function onRequestPost({ request, env }) {
  const malo = rechazoDePeticion(request);
  if (malo) return resp({ ok: false, error: 'Petición no válida.' }, malo);
  const db = env.oficina_ia_db;
  let s = null;
  try { s = await sesionAdminDeRequest(db, request); } catch (e) { console.log('[CONSOLA] planes sesión:', e?.message); }
  if (!s) return resp({ ok: false }, 401);
  let c = null;
  try { c = await request.json(); } catch { return resp({ ok: false, error: 'Petición no válida.' }, 400); }
  if (!c || typeof c.accion !== 'string') return resp({ ok: false, error: 'Petición no válida.' }, 400);
  const adminId = s.adminId; const planId = Number(c.plan_id);
  const necesitaPlan = ['vista_previa', 'precio', 'limites', 'activo'].includes(c.accion);
  if (necesitaPlan && (!Number.isInteger(planId) || planId <= 0)) return resp({ ok: false, error: 'Petición no válida.' }, 400);
  try {
    let r;
    switch (c.accion) {
      case 'vista_previa': case 'precio': {
        const precio = montoACentavos(c.precio);
        if (precio === null || typeof c.aplicar_a !== 'string') return resp({ ok: false, error: 'El precio no es válido.' }, 400);
        r = c.accion === 'precio'
          ? await cambiarPrecioPlan(db, { planId, nuevoCentavos: precio, aplicarA: c.aplicar_a, adminId })
          : await vistaPreviaCambioPrecio(db, planId, precio, c.aplicar_a);
        break;
      }
      case 'limites': {
        const w = tope(c.limite_whatsapp), i = tope(c.limite_ia);
        if (w === undefined || i === undefined) return resp({ ok: false, error: 'Los límites deben ser números enteros (o vacío = sin tope).' }, 400);
        r = await actualizarLimitesPlan(db, { planId, limiteWhatsapp: w, limiteIa: i, adminId });
        break;
      }
      case 'crear': {
        const precio = montoACentavos(c.precio), w = tope(c.limite_whatsapp), i = tope(c.limite_ia);
        if (precio === null || w === undefined || i === undefined || typeof c.nombre !== 'string') return resp({ ok: false, error: 'Revisa el nombre, el precio y los límites.' }, 400);
        r = await crearPlan(db, { nombre: c.nombre, precioCentavos: precio, limiteWhatsapp: w, limiteIa: i, adminId });
        break;
      }
      case 'activo': r = await cambiarEstadoPlan(db, { planId, activo: c.activo === true, adminId }); break;
      case 'gracia': {
        const dias = Number(c.dias);
        if (!Number.isInteger(dias)) return resp({ ok: false, error: 'Los días de gracia deben ser un número entero.' }, 400);
        r = await guardarAjuste(db, 'dias_gracia', dias, adminId);
        break;
      }
      default: return resp({ ok: false, error: 'Acción no válida.' }, 400);
    }
    return resp(r, r.ok ? 200 : 400);
  } catch (e) { console.log('[CONSOLA] planes:', e?.message); return resp({ ok: false, error: 'No se pudo completar la acción.' }, 500); }
}