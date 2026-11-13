// functions/lib/suscripcion.js
// Suscripciones, planes, precios, pagos de suscripción y uso mensual.
//
// CONTRATO CON EL BOT (WhatsApp y chat web). Estas firmas no cambian sin avisar:
//   estadoServicio(env, negocioId, ahora?)  → { permitido, estado, motivo?, vence_en?, dias_para_vencer?, dias_gracia_restantes?, aviso? }
//   puedeUsarIA(env, negocioId, ahora?)     → { permitido, motivo?, restante? }
//   registrarUso(env, negocioId, tipo, cantidad = 1, { tokensEntrada, tokensSalida } = {}) → boolean (nunca lanza)
//   estadoUsoWhatsApp(env, negocioId, ahora?) → { usados, limite, porcentaje, nivel: 'normal'|'aviso'|'tope' }
//   avisoDeUsoPendiente / marcarAvisoEnviado → para no repetir el aviso del mes
//
// Reglas de seguridad de servicio: si algo falla (tablas aún sin crear, error de base), NO se bloquea al cliente:
// se devuelve permitido = true y se anota el error en consola. Un negocio SIN suscripción registrada sigue funcionando
// ("sin_suscripcion") para no cortar a los clientes que ya existen antes de que se les cree su suscripción.
// Todo es solo-agregar: lo anulado se marca, nada se borra.

export const TIPOS_USO = ['whatsapp_entrante', 'whatsapp_saliente', 'whatsapp_facturable', 'ia_whatsapp', 'ia_web'];
export const METODOS_PAGO = ['yappy', 'transferencia', 'efectivo', 'otro'];
export const DIAS_AVISO_VENCIMIENTO = 3;
export const DIAS_GRACIA_POR_DEFECTO = 3;

// ───────────────────────── Fechas (hora de Panamá = UTC-5) ─────────────────────────
const desplazarPanama = (d) => new Date(d.getTime() - 5 * 3600 * 1000);
export const fechaPanama = (ahora = new Date()) => desplazarPanama(ahora).toISOString().slice(0, 10);
export const mesPanama = (ahora = new Date()) => fechaPanama(ahora).slice(0, 7);
const ES_FECHA = /^\d{4}-\d{2}-\d{2}$/;

const aUTC = (iso) => { const [a, m, d] = iso.split('-').map(Number); return Date.UTC(a, m - 1, d); };
export const diasEntre = (desdeIso, hastaIso) => Math.round((aUTC(hastaIso) - aUTC(desdeIso)) / 86400000);

export function sumarDias(iso, n) {
  const d = new Date(aUTC(iso) + n * 86400000);
  return d.toISOString().slice(0, 10);
}

/** Suma meses sin pasarse del fin de mes (31 ene + 1 mes = 28/29 feb). */
export function sumarMeses(iso, n) {
  const [a, m, d] = iso.split('-').map(Number);
  const total = (a * 12 + (m - 1)) + n;
  const anio = Math.floor(total / 12), mes = (total % 12) + 1;
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${anio}-${String(mes).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`;
}

export const centavosAMonto = (c) => Math.round(Number(c)) / 100;
export function montoACentavos(valor) {
  const n = Number(String(valor ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100000) return null;
  return Math.round(n * 100);
}

// ───────────────────────── Ajustes ─────────────────────────
export async function leerAjuste(db, clave, porDefecto = null) {
  try {
    const f = await db.prepare('SELECT valor FROM ajustes_plataforma WHERE clave = ?').bind(clave).first();
    return f ? f.valor : porDefecto;
  } catch { return porDefecto; }
}

export async function diasDeGracia(db) {
  const v = Number(await leerAjuste(db, 'dias_gracia', DIAS_GRACIA_POR_DEFECTO));
  return Number.isInteger(v) && v >= 0 && v <= 60 ? v : DIAS_GRACIA_POR_DEFECTO;
}

export async function guardarAjuste(db, clave, valor, adminId = null) {
  const CLAVES = { dias_gracia: (v) => Number.isInteger(v) && v >= 0 && v <= 60, porcentaje_aviso_uso: (v) => Number.isInteger(v) && v >= 1 && v <= 100 };
  if (!CLAVES[clave]) return { ok: false, error: 'Ajuste desconocido.' };
  const n = Number(valor);
  if (!CLAVES[clave](n)) return { ok: false, error: 'Valor no válido para ese ajuste.' };
  await db.prepare(
    `INSERT INTO ajustes_plataforma (clave, valor, actualizado_en) VALUES (?, ?, datetime('now'))
     ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en`
  ).bind(clave, String(n)).run();
  await auditar(db, adminId, 'ajuste_cambiado', 'ajuste', null, { clave, valor: n });
  return { ok: true };
}

// ───────────────────────── Auditoría ─────────────────────────
export async function auditar(db, adminId, accion, entidad = null, entidadId = null, detalle = null) {
  try {
    await db.prepare('INSERT INTO auditoria_admin (admin_id, accion, entidad, entidad_id, detalle) VALUES (?, ?, ?, ?, ?)')
      .bind(adminId ?? null, accion, entidad, entidadId ?? null, detalle ? JSON.stringify(detalle) : null).run();
  } catch (e) { console.log('[SUSCRIPCION] No pude auditar:', e?.message); }
}

// ───────────────────────── Estado de la suscripción ─────────────────────────
/**
 * Estado EFECTIVO de una suscripción guardada. Se calcula con la fecha: no hace falta ninguna tarea programada.
 * pendiente | activa | gracia | vencida | suspendida | cancelada
 */
export function evaluarEstado(sus, hoy, diasGracia) {
  if (!sus) return { estado: 'sin_suscripcion' };
  if (sus.estado === 'cancelada') return { estado: 'cancelada' };
  if (sus.estado === 'suspendida') return { estado: 'suspendida' };
  if (sus.estado === 'pendiente') return { estado: 'pendiente' };
  if (!sus.vence_en || !ES_FECHA.test(sus.vence_en)) return { estado: 'pendiente' };
  const paraVencer = diasEntre(hoy, sus.vence_en);
  if (paraVencer >= 0) return { estado: 'activa', dias_para_vencer: paraVencer };
  const pasados = -paraVencer;
  if (pasados <= diasGracia) return { estado: 'gracia', dias_gracia_restantes: diasGracia - pasados };
  return { estado: 'vencida', dias_vencida: pasados - diasGracia };
}

export async function suscripcionVigente(db, negocioId) {
  return await db.prepare(
    `SELECT s.*, p.nombre AS plan_nombre, p.limite_whatsapp_mes, p.limite_ia_mes
       FROM suscripciones s JOIN planes p ON p.id = s.plan_id
      WHERE s.negocio_id = ? AND s.estado <> 'cancelada' ORDER BY s.id DESC LIMIT 1`
  ).bind(negocioId).first();
}

const MOTIVOS = {
  pendiente: 'La suscripción todavía no está activada (falta el primer pago).',
  vencida: 'La suscripción venció.',
  suspendida: 'La suscripción está suspendida.',
  cancelada: 'La suscripción fue cancelada.',
};

export const TEXTO_SERVICIO_NO_DISPONIBLE =
  'Tu suscripción de Oficina IA no está activa en este momento. Para renovarla o resolverlo, contacta a TechZone Panamá. Tus datos están guardados y no se pierde nada.';

/** Texto de aviso para el cliente según el estado (el bot lo agrega a su respuesta). null si no hay nada que avisar. */
export function textoAvisoServicio(est) {
  if (!est) return null;
  if (est.aviso === 'gracia') {
    const d = est.dias_gracia_restantes;
    return `Tu suscripción venció. Tienes ${d} ${d === 1 ? 'día' : 'días'} de gracia: renueva con TechZone Panamá para no quedarte sin servicio.`;
  }
  if (est.aviso === 'por_vencer') {
    const d = est.dias_para_vencer;
    return d === 0 ? 'Tu suscripción vence hoy. Renueva con TechZone Panamá para seguir sin interrupciones.'
      : `Tu suscripción vence en ${d} ${d === 1 ? 'día' : 'días'}. Renueva con TechZone Panamá para seguir sin interrupciones.`;
  }
  return null;
}

/** ¿Este negocio puede recibir servicio ahora? Nunca lanza: ante un error, permite (no se corta a nadie por una falla nuestra). */
export async function estadoServicio(env, negocioId, ahora = new Date()) {
  try {
    const db = env.oficina_ia_db;
    const sus = await suscripcionVigente(db, negocioId);
    if (!sus) return { permitido: true, estado: 'sin_suscripcion' };
    const ev = evaluarEstado(sus, fechaPanama(ahora), await diasDeGracia(db));
    const base = { estado: ev.estado, vence_en: sus.vence_en ?? null };
    if (ev.estado === 'activa') {
      return { permitido: true, ...base, dias_para_vencer: ev.dias_para_vencer, ...(ev.dias_para_vencer <= DIAS_AVISO_VENCIMIENTO ? { aviso: 'por_vencer' } : {}) };
    }
    if (ev.estado === 'gracia') return { permitido: true, ...base, dias_gracia_restantes: ev.dias_gracia_restantes, aviso: 'gracia' };
    return { permitido: false, ...base, motivo: ev.estado };
  } catch (e) {
    console.log('[SUSCRIPCION] estadoServicio falló, se permite el servicio:', e?.message);
    return { permitido: true, estado: 'desconocido' };
  }
}

// ───────────────────────── Uso ─────────────────────────
/** Suma uso del mes. Nunca lanza ni bloquea. @returns {Promise<boolean>} */
export async function registrarUso(env, negocioId, tipo, cantidad = 1, { tokensEntrada = 0, tokensSalida = 0 } = {}, ahora = new Date()) {
  try {
    if (!TIPOS_USO.includes(tipo)) return false;
    const n = Math.trunc(Number(cantidad));
    const te = Math.max(0, Math.trunc(Number(tokensEntrada) || 0)), ts = Math.max(0, Math.trunc(Number(tokensSalida) || 0));
    if (!Number.isFinite(n) || n < 0 || !negocioId) return false;
    await env.oficina_ia_db.prepare(
      `INSERT INTO uso_mensual (negocio_id, mes, tipo, cantidad, tokens_entrada, tokens_salida) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(negocio_id, mes, tipo) DO UPDATE SET cantidad = cantidad + excluded.cantidad,
         tokens_entrada = tokens_entrada + excluded.tokens_entrada, tokens_salida = tokens_salida + excluded.tokens_salida,
         actualizado_en = datetime('now')`
    ).bind(negocioId, mesPanama(ahora), tipo, n, te, ts).run();
    return true;
  } catch (e) {
    console.log('[SUSCRIPCION] No pude registrar el uso:', e?.message);
    return false;
  }
}

/** Uso de un negocio en un mes: { tipo: {cantidad, tokens_entrada, tokens_salida} }. */
export async function usoDelMes(db, negocioId, mes) {
  const { results } = await db.prepare('SELECT tipo, cantidad, tokens_entrada, tokens_salida FROM uso_mensual WHERE negocio_id = ? AND mes = ?')
    .bind(negocioId, mes).all();
  const o = {};
  for (const t of TIPOS_USO) o[t] = { cantidad: 0, tokens_entrada: 0, tokens_salida: 0 };
  for (const r of results) o[r.tipo] = { cantidad: r.cantidad, tokens_entrada: r.tokens_entrada, tokens_salida: r.tokens_salida };
  return o;
}

/**
 * ¿Puede usar la IA (Groq)? El límite es UNO compartido entre WhatsApp y la web (ia_whatsapp + ia_web).
 * NULL en el plan = sin tope (hasta tener datos reales de consumo). Nunca lanza.
 */
export async function puedeUsarIA(env, negocioId, ahora = new Date()) {
  try {
    const est = await estadoServicio(env, negocioId, ahora);
    if (!est.permitido) return { permitido: false, motivo: est.motivo };
    const sus = await suscripcionVigente(env.oficina_ia_db, negocioId);
    const limite = sus?.limite_ia_mes;
    if (limite === null || limite === undefined) return { permitido: true };
    const uso = await usoDelMes(env.oficina_ia_db, negocioId, mesPanama(ahora));
    const usados = uso.ia_whatsapp.cantidad + uso.ia_web.cantidad;
    return usados >= limite ? { permitido: false, motivo: 'limite_ia', restante: 0 } : { permitido: true, restante: limite - usados };
  } catch (e) {
    console.log('[SUSCRIPCION] puedeUsarIA falló, se permite:', e?.message);
    return { permitido: true };
  }
}

/** Uso de WhatsApp frente al tope del plan (mensajes que el cliente envía). nivel: normal | aviso | tope */
export async function estadoUsoWhatsApp(env, negocioId, ahora = new Date()) {
  try {
    const db = env.oficina_ia_db;
    const sus = await suscripcionVigente(db, negocioId);
    const uso = await usoDelMes(db, negocioId, mesPanama(ahora));
    const usados = uso.whatsapp_entrante.cantidad;
    const limite = sus?.limite_whatsapp_mes ?? null;
    if (!limite) return { usados, limite: null, porcentaje: null, nivel: 'normal' };
    const porcentaje = Math.round((usados / limite) * 100);
    const umbral = Number(await leerAjuste(db, 'porcentaje_aviso_uso', 80)) || 80;
    return { usados, limite, porcentaje, nivel: usados >= limite ? 'tope' : porcentaje >= umbral ? 'aviso' : 'normal' };
  } catch (e) {
    console.log('[SUSCRIPCION] estadoUsoWhatsApp falló:', e?.message);
    return { usados: 0, limite: null, porcentaje: null, nivel: 'normal' };
  }
}

export const textoAvisoUsoWhatsApp = (est) => est.nivel === 'tope'
  ? 'Llegaste al límite de mensajes de WhatsApp de este mes. Sigue en tu oficina web: escribe "mi oficina" y ahí puedes consultar y registrar todo el mes.'
  : `Llevas ${est.usados} de ${est.limite} mensajes de WhatsApp este mes. Para no quedarte sin ellos, usa tu oficina web: escribe "mi oficina" y ahí puedes consultar y registrar todo el mes.`;

/** ¿Falta enviar este aviso este mes? (true = no se ha enviado todavía) */
export async function avisoDeUsoPendiente(env, negocioId, tipo, ahora = new Date()) {
  try {
    const f = await env.oficina_ia_db.prepare('SELECT 1 AS x FROM avisos_uso WHERE negocio_id = ? AND mes = ? AND tipo = ?').bind(negocioId, mesPanama(ahora), tipo).first();
    return !f;
  } catch { return false; }
}

/** Marca el aviso como enviado. @returns {Promise<boolean>} true solo para quien lo marcó primero (evita enviarlo dos veces). */
export async function marcarAvisoEnviado(env, negocioId, tipo, ahora = new Date()) {
  try {
    const r = await env.oficina_ia_db.prepare('INSERT OR IGNORE INTO avisos_uso (negocio_id, mes, tipo) VALUES (?, ?, ?)').bind(negocioId, mesPanama(ahora), tipo).run();
    return r.meta.changes === 1;
  } catch { return false; }
}

// ───────────────────────── Planes y precios (consola) ─────────────────────────
export async function listarPlanes(db) {
  const { results } = await db.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM suscripciones s WHERE s.plan_id = p.id AND s.estado <> 'cancelada') AS suscriptores
       FROM planes p ORDER BY p.id`
  ).all();
  return results;
}

/** Vista previa de un cambio de precio: cuántos suscriptores afecta y cuánto cambia el ingreso mensual. No guarda nada. */
export async function vistaPreviaCambioPrecio(db, planId, nuevoCentavos, aplicarA) {
  const plan = await db.prepare('SELECT * FROM planes WHERE id = ?').bind(planId).first();
  if (!plan) return { ok: false, error: 'Ese plan no existe.' };
  if (!Number.isInteger(nuevoCentavos) || nuevoCentavos < 0) return { ok: false, error: 'El precio no es válido.' };
  if (!['nuevos', 'todos'].includes(aplicarA)) return { ok: false, error: 'Indica si aplica a los nuevos o a todos.' };
  if (aplicarA === 'nuevos' && nuevoCentavos === plan.precio_centavos) return { ok: false, error: 'El plan ya tiene ese precio.' };
  const { results } = await db.prepare(
    `SELECT s.negocio_id, n.nombre, s.precio_centavos FROM suscripciones s JOIN negocios n ON n.id = s.negocio_id
      WHERE s.plan_id = ? AND s.estado IN ('activa','suspendida','pendiente') ORDER BY n.nombre COLLATE NOCASE`
  ).bind(planId).all();
  const afectados = aplicarA === 'todos' ? results.length : 0;
  const diferencia = aplicarA === 'todos' ? results.reduce((s, r) => s + (nuevoCentavos - r.precio_centavos), 0) : 0;
  return {
    ok: true, plan: plan.nombre, precio_actual_centavos: plan.precio_centavos, precio_nuevo_centavos: nuevoCentavos,
    aplicar_a: aplicarA, suscriptores_actuales: results.length, suscriptores_afectados: afectados, cambio_mensual_centavos: diferencia,
    clientes: aplicarA === 'todos' ? results.slice(0, 30).map((r) => ({ negocio_id: r.negocio_id, nombre: r.nombre, precio_actual_centavos: r.precio_centavos })) : [],
  };
}

/**
 * Cambia el precio del plan. Cada suscripción conserva el precio con el que entró, salvo que se elija "todos":
 * entonces el precio nuevo queda como precio_proximo y se aplica en su PRÓXIMO pago (nunca a mitad de período).
 */
export async function cambiarPrecioPlan(db, { planId, nuevoCentavos, aplicarA, adminId = null }) {
  const vp = await vistaPreviaCambioPrecio(db, planId, nuevoCentavos, aplicarA);
  if (!vp.ok) return vp;
  const sentencias = [
    db.prepare('UPDATE planes SET precio_centavos = ? WHERE id = ?').bind(nuevoCentavos, planId),
    db.prepare('INSERT INTO historial_precios (plan_id, precio_centavos, aplicado_a, admin_id) VALUES (?, ?, ?, ?)').bind(planId, nuevoCentavos, aplicarA, adminId),
  ];
  if (aplicarA === 'todos') {
    sentencias.push(db.prepare(
      "UPDATE suscripciones SET precio_proximo_centavos = ?, actualizado_en = datetime('now') WHERE plan_id = ? AND estado IN ('activa','suspendida','pendiente')"
    ).bind(nuevoCentavos, planId));
  }
  await db.batch(sentencias);
  const { clientes, ...cifras } = vp;
  await auditar(db, adminId, 'precio_cambiado', 'plan', planId, { ...cifras, clientes_ids: (clientes || []).map((c) => c.negocio_id) });
  return vp;
}

export async function actualizarLimitesPlan(db, { planId, limiteWhatsapp, limiteIa, adminId = null }) {
  const valido = (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 10000000);
  if (!valido(limiteWhatsapp) || !valido(limiteIa)) return { ok: false, error: 'Los límites deben ser números enteros (o vacío = sin tope).' };
  const r = await db.prepare('UPDATE planes SET limite_whatsapp_mes = ?, limite_ia_mes = ? WHERE id = ?').bind(limiteWhatsapp, limiteIa, planId).run();
  if (r.meta.changes !== 1) return { ok: false, error: 'Ese plan no existe.' };
  await auditar(db, adminId, 'limites_cambiados', 'plan', planId, { limiteWhatsapp, limiteIa });
  return { ok: true };
}

/** Crea un plan nuevo (queda en el historial de precios como 'inicial'). Los topes vacíos = sin tope. */
export async function crearPlan(db, { nombre, precioCentavos, limiteWhatsapp = null, limiteIa = null, adminId = null }) {
  const nom = String(nombre ?? '').trim();
  if (nom.length < 2 || nom.length > 40) return { ok: false, error: 'El nombre del plan debe tener entre 2 y 40 caracteres.' };
  if (!Number.isInteger(precioCentavos) || precioCentavos < 0 || precioCentavos > 10000000) return { ok: false, error: 'El precio no es válido.' };
  const valido = (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 10000000);
  if (!valido(limiteWhatsapp) || !valido(limiteIa)) return { ok: false, error: 'Los límites deben ser números enteros (o vacío = sin tope).' };
  if (await db.prepare('SELECT id FROM planes WHERE nombre = ? COLLATE NOCASE').bind(nom).first()) return { ok: false, error: 'Ya existe un plan con ese nombre.' };
  const r = await db.prepare('INSERT INTO planes (nombre, precio_centavos, limite_whatsapp_mes, limite_ia_mes) VALUES (?, ?, ?, ?)').bind(nom, precioCentavos, limiteWhatsapp, limiteIa).run();
  const id = r.meta.last_row_id;
  await db.prepare("INSERT INTO historial_precios (plan_id, precio_centavos, aplicado_a, admin_id) VALUES (?, ?, 'inicial', ?)").bind(id, precioCentavos, adminId).run();
  await auditar(db, adminId, 'plan_creado', 'plan', id, { nombre: nom, precioCentavos, limiteWhatsapp, limiteIa });
  return { ok: true, id };
}

/** Activa o desactiva un plan para NUEVAS altas (quien ya lo tiene lo conserva). Siempre debe quedar un plan activo. */
export async function cambiarEstadoPlan(db, { planId, activo, adminId = null }) {
  const plan = await db.prepare('SELECT * FROM planes WHERE id = ?').bind(planId).first();
  if (!plan) return { ok: false, error: 'Ese plan no existe.' };
  const nuevo = activo ? 1 : 0;
  if (plan.activo === nuevo) return { ok: false, error: nuevo ? 'El plan ya está activo.' : 'El plan ya está desactivado.' };
  if (!nuevo) {
    const otros = await db.prepare('SELECT COUNT(*) AS c FROM planes WHERE activo = 1 AND id <> ?').bind(planId).first();
    if (!otros || otros.c < 1) return { ok: false, error: 'Debe quedar al menos un plan activo.' };
  }
  await db.prepare('UPDATE planes SET activo = ? WHERE id = ?').bind(nuevo, planId).run();
  await auditar(db, adminId, nuevo ? 'plan_activado' : 'plan_desactivado', 'plan', planId, { nombre: plan.nombre });
  return { ok: true };
}

/** Historial de cambios de precio (los más recientes primero). */
export async function historialPrecios(db, limite = 40) {
  const { results } = await db.prepare(
    `SELECT h.id, h.plan_id, p.nombre AS plan, h.precio_centavos, h.aplicado_a, h.creado_en, a.nombre AS admin
       FROM historial_precios h JOIN planes p ON p.id = h.plan_id LEFT JOIN admin_usuarios a ON a.id = h.admin_id
      ORDER BY h.id DESC LIMIT ?`
  ).bind(limite).all();
  return results || [];
}

// ───────────────────────── Suscripciones (consola) ─────────────────────────
/** Alta de la suscripción de un negocio. Queda 'pendiente' hasta registrar el primer pago (no hay prueba gratis). */
export async function altaSuscripcion(db, { negocioId, planId, adminId = null, ahora = new Date() }) {
  const neg = await db.prepare('SELECT id FROM negocios WHERE id = ?').bind(negocioId).first();
  if (!neg) return { ok: false, error: 'Ese negocio no existe.' };
  const plan = await db.prepare('SELECT * FROM planes WHERE id = ? AND activo = 1').bind(planId).first();
  if (!plan) return { ok: false, error: 'Ese plan no existe o está desactivado.' };
  if (await suscripcionVigente(db, negocioId)) return { ok: false, error: 'Ese negocio ya tiene una suscripción vigente.' };
  const r = await db.prepare('INSERT INTO suscripciones (negocio_id, plan_id, estado, precio_centavos) VALUES (?, ?, ?, ?)')
    .bind(negocioId, planId, 'pendiente', plan.precio_centavos).run();
  const id = r.meta.last_row_id;
  await auditar(db, adminId, 'suscripcion_creada', 'suscripcion', id, { negocioId, planId, precio_centavos: plan.precio_centavos });
  return { ok: true, id };
}

/**
 * Registra un pago de la suscripción y extiende un mes. La cobertura empieza donde terminaba la anterior si aún estaba
 * vigente o en gracia (no se regalan ni se pierden días); si ya estaba vencida o es el primer pago, empieza hoy.
 * Aplica el precio nuevo si el plan cambió con "todos". Reactiva el negocio (negocios.activo = 1).
 */
export async function registrarPagoSuscripcion(db, { negocioId, montoCentavos, metodo, referencia = null, fecha = null, adminId = null, ahora = new Date() }) {
  if (!METODOS_PAGO.includes(metodo)) return { ok: false, error: 'Método de pago no válido.' };
  if (!Number.isInteger(montoCentavos) || montoCentavos <= 0 || montoCentavos > 10000000) return { ok: false, error: 'El monto no es válido.' };
  const ref = referencia === null || referencia === undefined || String(referencia).trim() === '' ? null : String(referencia).trim().slice(0, 80);
  const hoy = fechaPanama(ahora);
  const fechaPago = fecha ?? hoy;
  if (!ES_FECHA.test(fechaPago) || fechaPago > hoy) return { ok: false, error: 'La fecha del pago no es válida (no puede ser futura).' };
  const sus = await suscripcionVigente(db, negocioId);
  if (!sus) return { ok: false, error: 'Ese negocio no tiene suscripción. Créala primero.' };
  if (sus.estado === 'suspendida') return { ok: false, error: 'La suscripción está suspendida. Reactívala antes de registrar el pago.' };
  const gracia = await diasDeGracia(db);
  const ev = evaluarEstado(sus, hoy, gracia);
  const sigueCubierta = (ev.estado === 'activa' || ev.estado === 'gracia') && sus.vence_en;
  const desde = sigueCubierta ? sumarDias(sus.vence_en, 1) : hoy;
  const hasta = sumarDias(sumarMeses(desde, 1), -1); // un mes completo: el último día cubierto es la víspera del mismo día del mes siguiente
  const precio = sus.precio_proximo_centavos ?? sus.precio_centavos;
  const [insert] = await db.batch([
    db.prepare(
      `INSERT INTO pagos_suscripcion (suscripcion_id, negocio_id, fecha, monto_centavos, metodo, referencia, periodo_desde, periodo_hasta, admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(sus.id, negocioId, fechaPago, montoCentavos, metodo, ref, desde, hasta, adminId),
    db.prepare(
      `UPDATE suscripciones SET estado = 'activa', vence_en = ?, inicio = COALESCE(inicio, ?), precio_centavos = ?, precio_proximo_centavos = NULL,
              actualizado_en = datetime('now') WHERE id = ?`
    ).bind(hasta, desde, precio, sus.id),
    db.prepare('UPDATE negocios SET activo = 1 WHERE id = ?').bind(negocioId),
  ]);
  const pagoId = insert.meta.last_row_id;
  await auditar(db, adminId, 'pago_registrado', 'suscripcion', sus.id, { pagoId, montoCentavos, metodo, referencia: ref, periodo_desde: desde, periodo_hasta: hasta });
  return { ok: true, pagoId, periodo_desde: desde, periodo_hasta: hasta, vence_en: hasta };
}

export async function suspenderSuscripcion(db, { negocioId, motivo = null, adminId = null }) {
  const sus = await suscripcionVigente(db, negocioId);
  if (!sus) return { ok: false, error: 'Ese negocio no tiene suscripción.' };
  if (sus.estado === 'suspendida') return { ok: false, error: 'Ya está suspendida.' };
  await db.batch([
    db.prepare("UPDATE suscripciones SET estado = 'suspendida', actualizado_en = datetime('now') WHERE id = ?").bind(sus.id),
    db.prepare('UPDATE negocios SET activo = 0 WHERE id = ?').bind(negocioId),
  ]);
  await auditar(db, adminId, 'suscripcion_suspendida', 'suscripcion', sus.id, { negocioId, motivo: motivo ? String(motivo).slice(0, 200) : null });
  return { ok: true };
}

/** Reactiva una suscripción suspendida: vuelve a 'activa' si todavía tiene días pagados, si no a 'pendiente'. */
export async function reactivarSuscripcion(db, { negocioId, adminId = null, ahora = new Date() }) {
  const sus = await suscripcionVigente(db, negocioId);
  if (!sus) return { ok: false, error: 'Ese negocio no tiene suscripción.' };
  if (sus.estado !== 'suspendida') return { ok: false, error: 'La suscripción no está suspendida.' };
  const nuevo = sus.vence_en ? 'activa' : 'pendiente';
  await db.batch([
    db.prepare("UPDATE suscripciones SET estado = ?, actualizado_en = datetime('now') WHERE id = ?").bind(nuevo, sus.id),
    db.prepare('UPDATE negocios SET activo = 1 WHERE id = ?').bind(negocioId),
  ]);
  await auditar(db, adminId, 'suscripcion_reactivada', 'suscripcion', sus.id, { negocioId, estado: nuevo });
  return { ok: true, estado: nuevo };
}

export async function cancelarSuscripcion(db, { negocioId, motivo = null, adminId = null }) {
  const sus = await suscripcionVigente(db, negocioId);
  if (!sus) return { ok: false, error: 'Ese negocio no tiene suscripción.' };
  await db.prepare("UPDATE suscripciones SET estado = 'cancelada', actualizado_en = datetime('now') WHERE id = ?").bind(sus.id).run();
  await auditar(db, adminId, 'suscripcion_cancelada', 'suscripcion', sus.id, { negocioId, motivo: motivo ? String(motivo).slice(0, 200) : null });
  return { ok: true };
}

export async function cambiarPlanSuscripcion(db, { negocioId, planId, adminId = null }) {
  const sus = await suscripcionVigente(db, negocioId);
  if (!sus) return { ok: false, error: 'Ese negocio no tiene suscripción.' };
  const plan = await db.prepare('SELECT * FROM planes WHERE id = ? AND activo = 1').bind(planId).first();
  if (!plan) return { ok: false, error: 'Ese plan no existe o está desactivado.' };
  if (plan.id === sus.plan_id) return { ok: false, error: 'Ya está en ese plan.' };
  // El precio del plan nuevo rige desde el próximo pago: lo ya pagado no se toca.
  await db.prepare("UPDATE suscripciones SET plan_id = ?, precio_proximo_centavos = ?, actualizado_en = datetime('now') WHERE id = ?").bind(plan.id, plan.precio_centavos, sus.id).run();
  await auditar(db, adminId, 'plan_cambiado', 'suscripcion', sus.id, { negocioId, de: sus.plan_id, a: plan.id });
  return { ok: true };
}