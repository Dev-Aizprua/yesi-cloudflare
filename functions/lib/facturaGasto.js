// functions/lib/facturaGasto.js
// FOTO DE UNA FACTURA DE COMPRA → ¿GASTO o CUADRO?
// Funciones PURAS (sin Groq, sin base de datos salvo buscarGastoDeFactura, que recibe la base): reconocen si lo que se leyó de una
// foto es una factura de compra, arman el gasto único (proveedor, fecha, total, N° de factura) y la guardia contra duplicados.
// Principios del proyecto: el CÓDIGO decide (Groq solo transcribió); nada se guarda sin vista previa y "sí"; "por completar"
// antes que adivinar (si la fecha se leyó dudosa, se PREGUNTA, no se adivina).

import { formatoMonto, fechaLegible } from './pagos.js';

const sinTildes = x => String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const claveEtiqueta = e => sinTildes(e).replace(/[^a-z0-9]+/g, ' ').trim().replace(/\br u c\b/, 'ruc');
const redondear2 = n => Math.round(n * 100) / 100;
const DIA = 86400000;

const ETIQUETAS_PROVEEDOR = new Set(['negocio', 'proveedor', 'empresa', 'razon social', 'comercio', 'establecimiento', 'emisor']);
// "N° Int.", "No. Factura", "Número de factura", "Factura N°", "N° de documento", "Comprobante"
const RE_ETIQUETA_NUMERO = /^(?:(?:n|no|nro|num|numero)(?: de)? (?:int|interno|factura|fact|documento|doc|comprobante)|(?:factura|documento|comprobante)(?: (?:n|no|nro|numero))?)$/;

function valorDe(encabezado, quien) {
  for (const c of Array.isArray(encabezado) ? encabezado : []) {
    if (c?.valor === null || c?.valor === undefined) continue;
    const v = String(c.valor).trim();
    if (v !== '' && quien(claveEtiqueta(c.etiqueta))) return v;
  }
  return null;
}

/** "8.859.2144 Dv. 08-DV. 9" y "8-859-2144" → "88592144": solo el RUC, sin el dígito verificador y sin separadores. */
export function normalizarRuc(texto) {
  const antesDelDv = String(texto ?? '').split(/d\.?\s*v/i)[0];
  const digitos = antesDelDv.replace(/\D/g, '');
  return digitos.length >= 5 ? digitos : null;
}

/** Fecha escrita día/mes/año (formato de Panamá) o AAAA-MM-DD. null si no se reconoce. */
export function leerFecha(texto) {
  const s = String(texto ?? '');
  let d, mo, y;
  let m = s.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})\b/);
  if (m) { d = Number(m[1]); mo = Number(m[2]); y = Number(m[3]); if (m[3].length === 2) y += 2000; }
  else {
    m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (!m) return null;
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
  }
  const f = new Date(Date.UTC(y, mo - 1, d));
  const existe = f.getUTCFullYear() === y && f.getUTCMonth() === mo - 1 && f.getUTCDate() === d;
  const dos = n => String(n).padStart(2, '0');
  return { existe, ms: f.getTime(), iso: existe ? `${y}-${dos(mo)}-${dos(d)}` : null };
}

function hoyEnPanama(ahora) {
  const p = new Date(ahora.getTime() - 5 * 3600 * 1000);
  return Date.UTC(p.getUTCFullYear(), p.getUTCMonth(), p.getUTCDate());
}

/** 'ok' | 'futura' | 'antigua' (más de un año) | 'inexistente' | 'ausente' */
export function estadoFecha(f, ahora = new Date()) {
  if (!f) return 'ausente';
  if (!f.existe) return 'inexistente';
  const hoy = hoyEnPanama(ahora);
  if (f.ms > hoy + DIA) return 'futura';
  if (f.ms < hoy - 365 * DIA) return 'antigua';
  return 'ok';
}

/**
 * ¿Lo leído de la foto es una FACTURA DE COMPRA? Pide proveedor (negocio) + N° de factura + total > 0. Si falta algo, null:
 * la foto sigue su camino de siempre (cuadro). Las tablas de préstamos no traen encabezado ni pie, así que nunca llegan aquí.
 * @returns {null | { proveedor, ruc, rucTexto, numero, fechaTexto, fechaIso, fechaEstado, total }}
 */
export function reconocerFactura(encabezado, pie, ahora = new Date()) {
  const proveedor = valorDe(encabezado, c => ETIQUETAS_PROVEEDOR.has(c));
  const numeroCrudo = valorDe(encabezado, c => RE_ETIQUETA_NUMERO.test(c));
  const numero = numeroCrudo && /\d/.test(numeroCrudo) && numeroCrudo.length >= 3 ? numeroCrudo.slice(0, 40) : null;
  const filaTotal = (Array.isArray(pie) ? pie : []).find(f => (f?.clave === 'total' || claveEtiqueta(f?.etiqueta) === 'total') && typeof f?.valor === 'number' && Number.isFinite(f.valor));
  const total = filaTotal ? redondear2(filaTotal.valor) : null;
  if (!proveedor || !numero || !(total > 0)) return null;

  const rucTexto = valorDe(encabezado, c => c === 'ruc');
  const fechaTexto = valorDe(encabezado, c => c.startsWith('fecha') && !c.includes('venc'));
  const fecha = leerFecha(fechaTexto);
  return {
    proveedor: proveedor.slice(0, 60),
    ruc: normalizarRuc(rucTexto),
    rucTexto: rucTexto ? rucTexto.slice(0, 40) : null,
    numero,
    fechaTexto,
    fechaIso: fecha?.iso ?? null,
    fechaEstado: estadoFecha(fecha, ahora),
    total,
  };
}

/** ¿Ya hay un gasto vigente con ese N° de factura y ese proveedor (por RUC, o por nombre si el RUC no se leyó igual)? */
export async function buscarGastoDeFactura(db, negocioId, f) {
  try {
    const fila = await db.prepare(
      `SELECT id, fecha, monto, proveedor FROM gastos
       WHERE negocio_id = ? AND anulado = 0 AND numero_factura = ? AND (ruc_proveedor = ? OR LOWER(proveedor) = LOWER(?)) LIMIT 1`
    ).bind(negocioId, f.numero, f.ruc ?? '', f.proveedor).first();
    return { fila: fila || null, error: false };
  } catch (e) {
    // Lo más probable: la migración (columna numero_factura) todavía no se ha corrido. La foto sigue como cuadro.
    return { fila: null, error: true, mensaje: e?.message };
  }
}

/** El gasto único, en la misma forma que usa el bot para guardar gastos (tipoPendiente 'gasto'). */
export function armarDatosGasto(f, fechaIso) {
  const observaciones = `Factura N° ${f.numero}${f.rucTexto ? ` · RUC ${f.rucTexto}` : ''} (leída de una foto)`.slice(0, 200);
  return {
    tipoPendiente: 'gasto',
    fecha: fechaIso,
    total: f.total,
    origen: 'foto_factura',
    items: [{
      descripcion: `Compra en ${f.proveedor}`.slice(0, 80), monto: f.total, categoria: null, proveedor: f.proveedor,
      numero_factura: f.numero, ruc_proveedor: f.ruc, observaciones,
    }],
  };
}

export function textoPreguntaDestino(f) {
  return [
    `Parece una factura de compra de ${f.proveedor} por ${formatoMonto(f.total)} (N° ${f.numero}). ¿Cómo la registro?`,
    '',
    '1️⃣ Gasto — un solo gasto con proveedor, fecha, total y N° de factura',
    '2️⃣ Cuadro — una tabla con todas las líneas de la factura',
    '',
    'Responde 1 o 2 (o "no" para descartar la foto).',
  ].join('\n');
}

const MOTIVO_FECHA = {
  antigua: 'es de hace más de un año', futura: 'es una fecha futura', inexistente: 'no es una fecha que exista',
};
export function textoPedirFecha(f) {
  const leida = f.fechaEstado === 'ausente'
    ? 'No pude leer la fecha de la factura.'
    : `Leí la fecha ${f.fechaIso ? fechaLegible(f.fechaIso) : f.fechaTexto} y ${MOTIVO_FECHA[f.fechaEstado] || 'no parece correcta'}.`;
  return `${leida} ¿Cuál es? Escríbela así: 31/10/2026 (o responde "hoy").`;
}

export function textoVistaPreviaGastoFactura(gasto, f, hoyIso) {
  const it = gasto.items[0];
  const cuando = gasto.fecha === hoyIso ? `hoy ${fechaLegible(gasto.fecha)}` : fechaLegible(gasto.fecha);
  return [
    `Voy a registrar este gasto de tu factura (${cuando}):`,
    '',
    `${it.descripcion} — ${formatoMonto(it.monto)}`,
    `Factura N° ${f.numero}${f.rucTexto ? ` · RUC ${f.rucTexto}` : ''}`,
    '',
    '⚠️ Revisa contra tu factura el N°, el RUC y la fecha: son los datos que más se leen mal en una foto.',
    '',
    '¿Lo guardo? Responde "sí" o "no".',
  ].join('\n');
}

/** "1", "gasto" → 'gasto'; "2", "cuadro" → 'cuadro'; "3", "costo" → 'costo'; otra cosa → null. */
export function interpretarDestino(texto) {
  const t = sinTildes(texto).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(1|uno|gasto|un gasto|como gasto|registralo como gasto|es un gasto)$/.test(t)) return 'gasto';
  if (/^(2|dos|cuadro|un cuadro|como cuadro|tabla|una tabla|es un cuadro|como tabla)$/.test(t)) return 'cuadro';
  if (/^(3|tres|costo|un costo|como costo|es un costo)$/.test(t)) return 'costo';
  return null;
}

/** Respuesta a "¿cuál es la fecha?": "hoy", "ayer", "31/10/2026", "31/10". null si no se entiende o es futura / inexistente. */
export function interpretarFechaRespuesta(texto, ahora = new Date()) {
  const t = sinTildes(texto).trim();
  const hoy = hoyEnPanama(ahora);
  const iso = ms => new Date(ms).toISOString().slice(0, 10);
  if (/^(hoy|de hoy|es de hoy)$/.test(t)) return iso(hoy);
  if (/^(ayer|de ayer)$/.test(t)) return iso(hoy - DIA);
  let f = leerFecha(t);
  if (!f) {
    const m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})\b/);
    if (m) f = leerFecha(`${m[1]}/${m[2]}/${new Date(hoy).getUTCFullYear()}`);
  }
  if (!f || !f.existe || f.ms > hoy) return null;
  return f.iso;
}