// functions/lib/ventasGastos.js
// Ventas de contado y gastos (sin documento). Lógica PURA: interpretar lo que dijo Groq, calcular totales,
// armar vistas previas, elegir qué anular, detectar consultas y armar el resumen. Sin base de datos ni WhatsApp.
// Principios (los mismos de pagos): Groq solo EXTRAE valores crudos; el CÓDIGO calcula (cantidad × precio);
// nada se guarda sin vista previa y "sí" del usuario; lo anulado no se borra.

import { redondear2, formatoMonto, parsearMonto, interpretarFechaPago, fechaIsoPanama, fechaLegible } from './pagos.js';

export const MAX_ARTICULOS = 10;

const sinTildes = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const plano = t => sinTildes(t).replace(/[¿?¡!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
const limpiarTexto = (v, max) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : '';
};

// ── Fecha ────────────────────────────────────────────────────────────────────────────────────────
function resolverFecha(dicha, ahora) {
  const r = interpretarFechaPago(plano(dicha), ahora);
  if (r.ok) return { ok: true, fecha: r.fecha };
  const dijo = limpiarTexto(dicha, 30);
  const mensajes = {
    no_entendida: `No entendí la fecha "${dijo}". Dime "hoy", "ayer" o una fecha como 15/10/2026.`,
    futura: `La fecha "${dijo}" todavía no llega. Dime una fecha de hoy o anterior.`,
    inexistente: `La fecha "${dijo}" no existe en el calendario. Revísala y dímela otra vez.`,
  };
  return { ok: false, mensaje: mensajes[r.motivo] || mensajes.no_entendida };
}

// ── Ventas de contado ───────────────────────────────────────────────────────────────────────────
/**
 * @param {{ articulos?: Array<{descripcion, cantidad, precio, total}>, cliente?: string, fecha?: string }} args  lo que extrajo Groq
 * @returns {{ ok: true, items: object[], total: number, fecha: string, cliente: string|null }
 *          | { ok: false, mensaje: string }}
 */
export function armarVentas(args, ahora = new Date()) {
  const lista = Array.isArray(args?.articulos) ? args.articulos : [];
  if (lista.length === 0) return { ok: false, mensaje: 'No entendí qué vendiste. Dímelo así: "Vendí 3 jugos a 2.50".' };
  if (lista.length > MAX_ARTICULOS) return { ok: false, mensaje: `Son muchos artículos de una vez (máximo ${MAX_ARTICULOS}). Mándalos en dos mensajes.` };

  const f = resolverFecha(args?.fecha, ahora);
  if (!f.ok) return f;

  const items = [];
  for (const a of lista) {
    const descripcion = limpiarTexto(a?.descripcion, 80);
    if (!descripcion) return { ok: false, mensaje: 'No entendí qué vendiste. Dímelo así: "Vendí 3 jugos a 2.50".' };
    const hayCantidad = a?.cantidad !== null && a?.cantidad !== undefined && String(a.cantidad).trim() !== '';
    const hayPrecio = a?.precio !== null && a?.precio !== undefined && String(a.precio).trim() !== '';
    const hayTotal = a?.total !== null && a?.total !== undefined && String(a.total).trim() !== '';
    const cantidad = hayCantidad ? parsearMonto(a.cantidad) : 1;
    const precio = hayPrecio ? parsearMonto(a.precio) : null;
    const total = hayTotal ? parsearMonto(a.total) : null;
    if (cantidad === null || cantidad > 100000) return { ok: false, mensaje: `No entendí la cantidad de "${descripcion}". Dímela como número, por ejemplo "3".` };
    if (hayPrecio && precio === null) return { ok: false, mensaje: `No entendí el precio de "${descripcion}". Dímelo como número, por ejemplo "2.50".` };
    if (hayTotal && total === null) return { ok: false, mensaje: `No entendí el total de "${descripcion}". Dímelo como número, por ejemplo "10".` };
    if (precio === null && total === null) return { ok: false, mensaje: `¿A cuánto vendiste ${descripcion}? Dime el precio o el total, por ejemplo: "Vendí ${descripcion} a 2.50".` };

    let t, p, soloTotal = false;
    if (precio !== null) {
      t = redondear2(cantidad * precio);
      p = precio;
      if (total !== null && Math.abs(total - t) > 0.01) {
        return { ok: false, mensaje: `No me cuadra "${descripcion}": ${cantidad} × ${formatoMonto(precio)} = ${formatoMonto(t)}, pero dijiste un total de ${formatoMonto(total)}. Mándame la venta otra vez con el dato correcto.` };
      }
    } else {
      t = total;
      p = redondear2(total / cantidad);
      soloTotal = true;
    }
    if (t > 10000000) return { ok: false, mensaje: `El monto de "${descripcion}" me parece demasiado grande (${formatoMonto(t)}). Revísalo y mándalo otra vez.` };
    items.push({ descripcion, cantidad, precio: p, total: t, soloTotal });
  }
  const total = redondear2(items.reduce((s, i) => s + i.total, 0));
  return { ok: true, items, total, fecha: f.fecha, cliente: limpiarTexto(args?.cliente, 60) || null };
}

export function lineaVenta(i) {
  if (i.soloTotal) return `${i.descripcion}${i.cantidad !== 1 ? ` (${i.cantidad})` : ''} — ${formatoMonto(i.total)}`;
  return `${i.descripcion} — ${i.cantidad} × ${formatoMonto(i.precio)} = ${formatoMonto(i.total)}`;
}

export function textoVistaPreviaVenta(datos, hoy = fechaIsoPanama()) {
  const cuando = datos.fecha === hoy ? `hoy ${fechaLegible(datos.fecha)}` : fechaLegible(datos.fecha);
  const l = [`Voy a registrar esta venta de contado (${cuando}):`, ''];
  datos.items.forEach((i, n) => l.push(`${datos.items.length > 1 ? `${n + 1}. ` : ''}${lineaVenta(i)}`));
  if (datos.items.length > 1) l.push('', `Total: ${formatoMonto(datos.total)}`);
  if (datos.cliente) l.push(`Cliente: ${datos.cliente}`);
  l.push('', '¿La guardo? Responde "sí" o "no".');
  return l.join('\n');
}

// ── Gastos ───────────────────────────────────────────────────────────────────────────────────────
/**
 * @param {{ gastos?: Array<{descripcion, monto, categoria, proveedor}>, fecha?: string }} args
 */
export function armarGastos(args, ahora = new Date()) {
  const lista = Array.isArray(args?.gastos) ? args.gastos : [];
  if (lista.length === 0) return { ok: false, mensaje: 'No entendí qué gastaste. Dímelo así: "Gasté 45 en luz".' };
  if (lista.length > MAX_ARTICULOS) return { ok: false, mensaje: `Son muchos gastos de una vez (máximo ${MAX_ARTICULOS}). Mándalos en dos mensajes.` };
  const f = resolverFecha(args?.fecha, ahora);
  if (!f.ok) return f;

  const items = [];
  for (const g of lista) {
    const descripcion = limpiarTexto(g?.descripcion, 80);
    if (!descripcion) return { ok: false, mensaje: 'No entendí en qué fue el gasto. Dímelo así: "Gasté 45 en luz".' };
    const monto = parsearMonto(g?.monto);
    if (monto === null) return { ok: false, mensaje: `¿Cuánto fue el gasto de ${descripcion}? Dime el monto, por ejemplo: "Gasté 45 en ${descripcion}".` };
    if (monto > 10000000) return { ok: false, mensaje: `El monto de "${descripcion}" me parece demasiado grande (${formatoMonto(monto)}). Revísalo y mándalo otra vez.` };
    items.push({ descripcion, monto, categoria: limpiarTexto(g?.categoria, 40) || null, proveedor: limpiarTexto(g?.proveedor, 60) || null });
  }
  const total = redondear2(items.reduce((s, i) => s + i.monto, 0));
  return { ok: true, items, total, fecha: f.fecha };
}

export function lineaGasto(i) {
  const extra = [i.categoria, i.proveedor ? `a ${i.proveedor}` : null].filter(Boolean).join(', ');
  return `${i.descripcion} — ${formatoMonto(i.monto)}${extra ? ` (${extra})` : ''}`;
}

export function textoVistaPreviaGasto(datos, hoy = fechaIsoPanama()) {
  const cuando = datos.fecha === hoy ? `hoy ${fechaLegible(datos.fecha)}` : fechaLegible(datos.fecha);
  const l = [`Voy a registrar ${datos.items.length > 1 ? 'estos gastos' : 'este gasto'} (${cuando}):`, ''];
  datos.items.forEach((i, n) => l.push(`${datos.items.length > 1 ? `${n + 1}. ` : ''}${lineaGasto(i)}`));
  if (datos.items.length > 1) l.push('', `Total: ${formatoMonto(datos.total)}`);
  l.push('', '¿Lo guardo? Responde "sí" o "no".');
  return l.join('\n');
}

// ── Anular la última venta / el último gasto ─────────────────────────────────────────────────────
const RE_VERBO_ANULAR = /\b(anul\w*|elimin\w*|borr\w*|deshaz\w*|deshac\w*|cancel\w*)\b/;
const RELLENO = new Set(['de', 'del', 'la', 'el', 'las', 'los', 'a', 'al', 'en', 'por', 'que', 'hice', 'hize', 'registre', 'mi', 'mis', 'esa', 'ese', 'una', 'un', 'por', 'favor', 'porfa', 'ultima', 'ultimo', 'anterior']);

/**
 * "Anula la última venta", "borra el último gasto", "anula el gasto de luz".
 * Se detecta en código (0 tokens). Solo si la palabra venta/gasto va JUSTO después del verbo y artículo,
 * así "elimina el cuadro Ventas" o "anula el último abono de Yisel" no entran aquí.
 * @returns {{ tipo: 'venta'|'gasto', ultima: boolean, filtro: string[] } | null}
 */
export function detectarAnularRegistro(texto) {
  const original = String(texto ?? '');
  if (/\?/.test(original)) return null;
  const t = plano(original);
  if (!t || t.length > 90) return null;
  if (/^(?:como|puedo|se puede|es posible|quiero saber|que pasa)\b/.test(t)) return null;
  if (/\bno\s+(?:\w+\s+)?(?:anul|cancel|borr|elimin|deshaz)/.test(t)) return null;
  const m = t.match(/\b(?:anul\w*|elimin\w*|borr\w*|deshaz\w*|deshac\w*|cancel\w*)\s+(?:(?:por favor|porfa)\s+)?(?:(?:la|el|esa|ese|mi)\s+)?(?:(ultim[oa]|anterior)\s+)?(venta|gasto)\b(.*)$/);
  if (!m || !RE_VERBO_ANULAR.test(t)) return null;
  const resto = m[3] || '';
  if (/\b(cuadro|abono|pago|factura|cotizacion|proforma|tabla|excel)\b/.test(resto)) return null;
  const ultima = !!m[1] || /\bultim[oa]\b/.test(resto);
  const filtro = resto.split(' ').filter(p => p.length >= 3 && !RELLENO.has(p));
  return { tipo: m[2], ultima, filtro };
}

/**
 * Elige el registro a anular entre los VIGENTES (más reciente primero).
 * @param {Array<{id, descripcion, cliente_nombre?, proveedor?}>} registros
 * @returns {{tipo:'ok', registro} | {tipo:'sin_registros'|'sin_criterio'|'ninguno'} | {tipo:'ambiguo', candidatos: object[]}}
 */
export function elegirRegistroAAnular(registros, pedido) {
  const lista = registros || [];
  if (lista.length === 0) return { tipo: 'sin_registros' };
  if (pedido.filtro.length === 0) return pedido.ultima ? { tipo: 'ok', registro: lista[0] } : { tipo: 'sin_criterio' };
  const coinciden = lista.filter(r => {
    const base = sinTildes(`${r.descripcion ?? ''} ${r.cliente_nombre ?? ''} ${r.proveedor ?? ''}`);
    return pedido.filtro.every(p => base.includes(p));
  });
  if (coinciden.length === 0) return { tipo: 'ninguno' };
  if (coinciden.length === 1 || pedido.ultima) return { tipo: 'ok', registro: coinciden[0] };
  return { tipo: 'ambiguo', candidatos: coinciden.slice(0, 5) };
}

export function textoPrevioAnularRegistro(tipo, linea, fecha) {
  const esVenta = tipo === 'venta';
  return [`Voy a anular ${esVenta ? 'esta venta' : 'este gasto'} (${fechaLegible(fecha)}):`, `* ${linea}`, '',
    `No se borra: ${esVenta ? 'queda anulada' : 'queda anulado'} y deja de contar en los totales. ${esVenta ? '¿La anulo?' : '¿Lo anulo?'} Responde "sí" o "no".`].join('\n');
}

export function textoSinRegistrosAnular(tipo) {
  return tipo === 'venta' ? 'No tienes ventas registradas para anular.' : 'No tienes gastos registrados para anular.';
}
export function textoPedirCriterioAnular(tipo) {
  return tipo === 'venta'
    ? 'Dime cuál: "anula la última venta" o "anula la venta de <producto o cliente>".'
    : 'Dime cuál: "anula el último gasto" o "anula el gasto de <concepto>".';
}
export function textoNingunoAnular(tipo) {
  return `No encontré ${tipo === 'venta' ? 'una venta' : 'un gasto'} con eso entre los vigentes. Prueba con "anula ${tipo === 'venta' ? 'la última venta' : 'el último gasto'}".`;
}
export function textoAmbiguoAnular(tipo, candidatos, describir) {
  return [`Hay varios ${tipo === 'venta' ? 'ventas' : 'gastos'} que encajan:`, ...candidatos.map(c => `* ${describir(c)} (${fechaLegible(c.fecha)})`),
    `Dime "anula ${tipo === 'venta' ? 'la última venta' : 'el último gasto'} de ..." para quedarme con el más reciente.`].join('\n');
}

// ── Consultas: "¿cuánto vendí hoy?", "gastos del mes" ─────────────────────────────────────────────
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre'];
const NOMBRE_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const NUM_MES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

function isoDe(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function sumarDias(isoFecha, n) {
  const [y, m, d] = isoFecha.split('-').map(Number);
  const f = new Date(Date.UTC(y, m - 1, d + n));
  return isoDe(f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate());
}
function ultimoDiaMes(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/**
 * Período pedido en el texto (hoy por defecto). Fechas ISO de Panamá, ambos extremos incluidos.
 * @returns {{ desde: string, hasta: string, etiqueta: string }}
 */
export function periodoDesdeTexto(texto, ahora = new Date()) {
  const t = plano(texto);
  const hoy = fechaIsoPanama(ahora);
  const [y, m] = hoy.split('-').map(Number);
  const dHoy = Number(hoy.slice(8, 10));
  const diaSemana = new Date(Date.UTC(y, m - 1, dHoy)).getUTCDay(); // 0=domingo
  const lunes = sumarDias(hoy, -((diaSemana + 6) % 7));

  if (/\bayer\b/.test(t)) { const f = sumarDias(hoy, -1); return { desde: f, hasta: f, etiqueta: `ayer (${fechaLegible(f)})` }; }
  if (/\bsemana pasada\b|\bsemana anterior\b/.test(t)) {
    const d = sumarDias(lunes, -7); const h = sumarDias(lunes, -1);
    return { desde: d, hasta: h, etiqueta: `la semana pasada (${fechaLegible(d)} al ${fechaLegible(h)})` };
  }
  if (/\besta semana\b|\bsemana\b/.test(t)) return { desde: lunes, hasta: hoy, etiqueta: `esta semana (desde el ${fechaLegible(lunes)})` };
  if (/\bmes pasado\b|\bmes anterior\b/.test(t)) {
    const pm = m === 1 ? 12 : m - 1; const py = m === 1 ? y - 1 : y;
    return { desde: isoDe(py, pm, 1), hasta: isoDe(py, pm, ultimoDiaMes(py, pm)), etiqueta: `${NOMBRE_MES[pm - 1]} ${py}` };
  }
  if (/\beste ano\b|\bdel ano\b|\bano\b/.test(t)) return { desde: isoDe(y, 1, 1), hasta: hoy, etiqueta: `este año (${y})` };
  const nombre = MESES.find(mes => new RegExp(`\\b${mes}\\b`).test(t));
  if (nombre) {
    const nm = NUM_MES[nombre]; const ny = nm > m ? y - 1 : y;
    const hasta = nm === m && ny === y ? hoy : isoDe(ny, nm, ultimoDiaMes(ny, nm));
    return { desde: isoDe(ny, nm, 1), hasta, etiqueta: `${NOMBRE_MES[nm - 1]} ${ny}` };
  }
  if (/\beste mes\b|\bdel mes\b|\bmes\b/.test(t)) return { desde: isoDe(y, m, 1), hasta: hoy, etiqueta: `este mes (desde el 01/${String(m).padStart(2, '0')})` };
  return { desde: hoy, hasta: hoy, etiqueta: `hoy (${fechaLegible(hoy)})` };
}

const RE_EXCLUIR_CONSULTA = /\b(excel|pdf|cuadro|cuadros|factura|facturas|cotizacion|cotizaciones|proforma|imagen|foto|anul\w*|elimin\w*|borr\w*|agreg\w*|crea\w*|carga\w*|registr\w*|manda\w*|envia\w*|pasa\w*|hazme|haz|apunta\w*|anota\w*)\b/;

/**
 * ¿Es una consulta de ventas/gastos? ("¿cuánto vendí hoy?", "gastos del mes", "dame las ventas de ayer").
 * Solo si NO trae números ni verbos de escribir: "vendí 3 jugos" es un registro, no una consulta.
 * @returns {{ que: 'ventas'|'gastos'|'ambos', periodo: object } | null}
 */
export function detectarConsultaVentasGastos(texto, ahora = new Date()) {
  const t = plano(texto);
  if (!t || t.length > 80 || /\d/.test(t)) return null;
  if (RE_EXCLUIR_CONSULTA.test(t)) return null;
  const venta = /\b(vendi|vendido|vendimos|venta|ventas)\b/.test(t);
  const gasto = /\b(gaste|gastado|gastamos|gasto|gastos)\b/.test(t);
  if (!venta && !gasto) return null;
  const pregunta = /\b(cuanto|cuantos|cuantas|dime|dame|muestrame|ver|mis|mi|las|los|resumen|total|totales|como)\b/.test(t) || /^(ventas|gastos)\b/.test(t) || /\?/.test(String(texto ?? ''));
  if (!pregunta) return null;
  // "como me fue / como va mi negocio" (reporte general) es otra cosa: no se inventa aquí.
  if (/\b(negocio|ganancia|ganancias|utilidad|balance)\b/.test(t)) return null;
  return { que: venta && gasto ? 'ambos' : venta ? 'ventas' : 'gastos', periodo: periodoDesdeTexto(t, ahora) };
}

const MAX_DETALLE = 10;

/**
 * Resumen de ventas y/o gastos de un período. Los totales los suma el código.
 * @param {{ que: string, periodo: {etiqueta}, ventas: object[], gastos: object[] }} d  filas VIGENTES del período
 */
export function armarResumenVentasGastos(d) {
  const l = [];
  const totalV = redondear2((d.ventas || []).reduce((s, v) => s + Number(v.total || 0), 0));
  const totalG = redondear2((d.gastos || []).reduce((s, g) => s + Number(g.monto || 0), 0));
  const bloque = (titulo, filas, total, linea) => {
    l.push(`${titulo} de ${d.periodo.etiqueta}:`);
    if (filas.length === 0) { l.push('Sin registros en ese período.'); return; }
    l.push(`${filas.length} ${filas.length === 1 ? 'registro' : 'registros'}, total ${formatoMonto(total)}`);
    for (const f of filas.slice(0, MAX_DETALLE)) l.push(`• ${fechaLegible(f.fecha)} ${linea(f)}`);
    if (filas.length > MAX_DETALLE) l.push(`…y ${filas.length - MAX_DETALLE} más (el total las incluye todas).`);
  };
  if (d.que === 'ventas' || d.que === 'ambos') bloque('Ventas', d.ventas || [], totalV, v => lineaVenta({ descripcion: v.descripcion, cantidad: Number(v.cantidad), precio: Number(v.precio), total: Number(v.total), soloTotal: false }) + (v.cliente_nombre ? ` — ${v.cliente_nombre}` : ''));
  if (d.que === 'ambos') l.push('');
  if (d.que === 'gastos' || d.que === 'ambos') bloque('Gastos', d.gastos || [], totalG, g => lineaGasto({ descripcion: g.descripcion, monto: Number(g.monto), categoria: g.categoria, proveedor: g.proveedor }));
  if (d.que === 'ambos') {
    l.push('', `Ventas menos gastos: ${formatoMonto(redondear2(totalV - totalG))}${totalV - totalG < 0 ? ' (negativo)' : ''}`);
  }
  l.push('', 'Solo cuenta lo registrado como venta o gasto; los pagos de facturas proforma y los abonos de préstamos van aparte.');
  return l.join('\n');
}

/**
 * Red de seguridad: si Groq manda VARIAS llamadas a registrar_venta (o a registrar_gasto), el webhook solo
 * ejecutaría la primera. Se unen en una sola (artículos/gastos juntos; fecha y cliente de la primera que los traiga).
 * @returns {{ nombre: string, args: object } | null}  null si no aplica (una sola llamada o herramientas mezcladas)
 */
export function unirLlamadasVentasGastos(toolCalls) {
  const lista = Array.isArray(toolCalls) ? toolCalls : [];
  if (lista.length < 2) return null;
  const nombre = lista[0]?.function?.name;
  const campo = nombre === 'registrar_venta' ? 'articulos' : nombre === 'registrar_gasto' ? 'gastos' : null;
  if (!campo || !lista.every(c => c?.function?.name === nombre)) return null;
  const args = { [campo]: [] };
  for (const c of lista) {
    let a;
    try { a = JSON.parse(c.function.arguments || '{}'); } catch { return null; }
    if (Array.isArray(a[campo])) args[campo].push(...a[campo]);
    for (const k of ['fecha', 'cliente']) if (a[k] && !args[k]) args[k] = a[k];
  }
  return args[campo].length > 0 ? { nombre, args } : null;
}