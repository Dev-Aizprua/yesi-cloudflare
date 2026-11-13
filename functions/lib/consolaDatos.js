// functions/lib/consolaDatos.js
// Lecturas de la consola de administración (solo lectura). Nunca devuelve wa_token ni token de los negocios.
import { evaluarEstado, diasDeGracia, fechaPanama, mesPanama, usoDelMes, listarPlanes, suscripcionVigente, historialPrecios, leerAjuste } from './suscripcion.js';

const ETIQUETAS = { activa: 'Activa', gracia: 'En gracia', vencida: 'Vencida', suspendida: 'Suspendida', pendiente: 'Pendiente de pago', cancelada: 'Cancelada', sin_suscripcion: 'Sin suscripción' };
export const etiquetaEstado = (e) => ETIQUETAS[e] ?? e;

function armarFila(f, hoy, gracia) {
  const sus = f.sus_id ? { estado: f.sus_estado, vence_en: f.vence_en } : null;
  const ev = evaluarEstado(sus, hoy, gracia);
  const porVencer = ev.estado === 'activa' && ev.dias_para_vencer <= 7;
  return {
    negocio_id: f.id, nombre: f.nombre, slug: f.slug, telefono: f.telefono, servicio_activo: f.activo === 1,
    estado: ev.estado, estado_texto: etiquetaEstado(ev.estado), por_vencer: porVencer,
    dias_para_vencer: ev.dias_para_vencer ?? null, dias_gracia_restantes: ev.dias_gracia_restantes ?? null, dias_vencida: ev.dias_vencida ?? null,
    plan: f.plan_nombre ?? null, precio_centavos: f.precio_centavos ?? null, precio_proximo_centavos: f.precio_proximo_centavos ?? null,
    vence_en: f.vence_en ?? null, ultimo_pago_fecha: f.ultimo_pago_fecha ?? null, ultimo_pago_centavos: f.ultimo_pago_centavos ?? null,
  };
}

const SQL_FILAS = `
  SELECT n.id, n.nombre, n.slug, n.telefono, n.activo,
         s.id AS sus_id, s.estado AS sus_estado, s.vence_en, s.precio_centavos, s.precio_proximo_centavos, p.nombre AS plan_nombre,
         (SELECT pg.fecha FROM pagos_suscripcion pg WHERE pg.negocio_id = n.id AND pg.anulado = 0 ORDER BY pg.fecha DESC, pg.id DESC LIMIT 1) AS ultimo_pago_fecha,
         (SELECT pg.monto_centavos FROM pagos_suscripcion pg WHERE pg.negocio_id = n.id AND pg.anulado = 0 ORDER BY pg.fecha DESC, pg.id DESC LIMIT 1) AS ultimo_pago_centavos
    FROM negocios n
    LEFT JOIN suscripciones s ON s.negocio_id = n.id AND s.estado <> 'cancelada'
    LEFT JOIN planes p ON p.id = s.plan_id`;

export async function listarSuscriptores(db, ahora = new Date()) {
  const hoy = fechaPanama(ahora); const gracia = await diasDeGracia(db);
  const { results } = await db.prepare(`${SQL_FILAS} ORDER BY n.nombre COLLATE NOCASE`).all();
  return (results || []).map((f) => armarFila(f, hoy, gracia));
}

export async function resumenInicio(db, ahora = new Date()) {
  const filas = await listarSuscriptores(db, ahora);
  const cuenta = {}; let ingresoMensualCentavos = 0;
  for (const f of filas) {
    cuenta[f.estado] = (cuenta[f.estado] ?? 0) + 1;
    if (f.estado === 'activa' || f.estado === 'gracia') ingresoMensualCentavos += f.precio_proximo_centavos ?? f.precio_centavos ?? 0;
  }
  const mes = mesPanama(ahora);
  const cobrado = await db.prepare("SELECT COALESCE(SUM(monto_centavos),0) AS c, COUNT(*) AS n FROM pagos_suscripcion WHERE anulado = 0 AND substr(fecha,1,7) = ?").bind(mes).first();
  const uso = await db.prepare('SELECT tipo, SUM(cantidad) AS c FROM uso_mensual WHERE mes = ? GROUP BY tipo').bind(mes).all();
  const usoMes = {}; for (const u of uso.results || []) usoMes[u.tipo] = u.c;
  const atencion = filas
    .filter((f) => f.por_vencer || f.estado === 'gracia' || f.estado === 'vencida' || f.estado === 'pendiente')
    .sort((a, b) => (a.dias_para_vencer ?? -999) - (b.dias_para_vencer ?? -999)).slice(0, 12);
  return {
    mes, hoy: fechaPanama(ahora), total_negocios: filas.length,
    por_estado: { activa: cuenta.activa ?? 0, gracia: cuenta.gracia ?? 0, vencida: cuenta.vencida ?? 0, suspendida: cuenta.suspendida ?? 0, pendiente: cuenta.pendiente ?? 0, sin_suscripcion: cuenta.sin_suscripcion ?? 0 },
    por_vencer_7_dias: filas.filter((f) => f.por_vencer).length,
    ingreso_mensual_esperado_centavos: ingresoMensualCentavos,
    cobrado_mes_centavos: cobrado?.c ?? 0, pagos_mes: cobrado?.n ?? 0,
    uso_mes: { mensajes_entrantes: usoMes.whatsapp_entrante ?? 0, ia_whatsapp: usoMes.ia_whatsapp ?? 0, ia_web: usoMes.ia_web ?? 0 },
    atencion,
  };
}

export async function detalleSuscriptor(db, negocioId, ahora = new Date()) {
  if (!Number.isInteger(negocioId)) return null;
  const hoy = fechaPanama(ahora); const gracia = await diasDeGracia(db);
  const f = await db.prepare(`${SQL_FILAS} WHERE n.id = ?`).bind(negocioId).first();
  if (!f) return null;
  const fila = armarFila(f, hoy, gracia);
  const sus = await suscripcionVigente(db, negocioId);
  const pagos = await db.prepare(
    `SELECT id, fecha, monto_centavos, metodo, referencia, periodo_desde, periodo_hasta, anulado
       FROM pagos_suscripcion WHERE negocio_id = ? ORDER BY fecha DESC, id DESC LIMIT 50`).bind(negocioId).all();
  const uso = await usoDelMes(db, negocioId, mesPanama(ahora));
  const hist = await db.prepare(
    `SELECT accion, detalle, creado_en FROM auditoria_admin WHERE entidad = 'suscripcion' AND entidad_id IN (SELECT id FROM suscripciones WHERE negocio_id = ?) ORDER BY id DESC LIMIT 20`).bind(negocioId).all();
  return {
    ...fila, dias_gracia: gracia,
    limite_whatsapp_mes: sus?.limite_whatsapp_mes ?? null, limite_ia_mes: sus?.limite_ia_mes ?? null,
    pagos: pagos.results || [], uso_mes: uso,
    historial: (hist.results || []).map((h) => ({ accion: h.accion, creado_en: h.creado_en })),
    planes: (await listarPlanes(db)).filter((p) => p.activo === 1 || p.activo === undefined),
  };
}

/** Pantalla Planes y Precios: planes con cuántos suscriptores tienen, historial de precios y reglas de vencimiento. */
export async function vistaPlanes(db) {
  const porcentaje = Number(await leerAjuste(db, 'porcentaje_aviso_uso', '80'));
  return {
    planes: await listarPlanes(db),
    historial: await historialPrecios(db),
    dias_gracia: await diasDeGracia(db),
    porcentaje_aviso_uso: Number.isInteger(porcentaje) ? porcentaje : 80,
  };
}