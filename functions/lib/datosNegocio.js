// functions/lib/datosNegocio.js
// Datos del negocio para la oficina web (SOLO LECTURA). Reutiliza las mismas funciones de cálculo que el bot
// (reportes.js, pagos.js, ventasGastos.js) para que una cifra tenga una sola verdad: lo que dice WhatsApp y
// lo que dice la web coinciden. Todo se filtra por negocio_id, que sale de la sesión, nunca del navegador.

import { redondear2, calcularSaldos, extraerPrestamosDeCuadros, agruparSaldosAFavor, mismoCliente, fechaIsoPanama } from './pagos.js';
import { agruparDeudaVentas } from './ventasGastos.js';
import { calcularReporte, detectarPedidoReporte, periodoAnterior, topProductos } from './reportes.js';
import { claveProducto } from './costos.js';

// Igual que normalizarClave de whatsapp.js (las claves de las columnas de los cuadros)
export function normalizarClave(texto) {
  return String(texto)
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s_]/g, '').trim().replace(/[\s_]+/g, '_').replace(/^_+|_+$/g, '');
}

const suma = (arr, k) => redondear2((arr || []).reduce((s, x) => s + Number(x[k] || 0), 0));

export async function leerVentasYGastos(db, negocioId, desde, hasta) {
  const ventas = (await db.prepare(
    'SELECT fecha, descripcion, cantidad, total, estado, a_credito FROM ventas WHERE negocio_id = ? AND anulado = 0 AND fecha >= ? AND fecha <= ? LIMIT 5000'
  ).bind(negocioId, desde, hasta).all()).results;
  const gastos = (await db.prepare(
    'SELECT fecha, descripcion, monto FROM gastos WHERE negocio_id = ? AND anulado = 0 AND fecha >= ? AND fecha <= ? LIMIT 5000'
  ).bind(negocioId, desde, hasta).all()).results;
  return { ventas, gastos };
}

export async function cargarFichasCosto(db, negocioId) {
  return (await db.prepare(
    'SELECT id, producto, clave, componentes, total, rinde, costo_unidad FROM fichas_costo WHERE negocio_id = ? AND vigente = 1 ORDER BY producto LIMIT 200'
  ).bind(negocioId).all()).results;
}

export async function cargarProductosInventario(db, negocioId) {
  const { results } = await db.prepare(
    `SELECT p.id, p.producto, p.clave, p.minimo,
            COALESCE((SELECT SUM(m.cantidad) FROM inventario_movimientos m WHERE m.producto_id = p.id AND m.anulado = 0), 0) AS stock
     FROM inventario_productos p WHERE p.negocio_id = ? AND p.activo = 1 ORDER BY p.producto LIMIT 300`
  ).bind(negocioId).all();
  return results.map(p => ({ ...p, stock: redondear2(Number(p.stock)), minimo: p.minimo === null || p.minimo === undefined ? null : Number(p.minimo) }));
}

export async function cargarVentasFiadasConSaldo(db, negocioId) {
  const { results } = await db.prepare(
    `SELECT v.id, v.cliente_nombre, v.fecha, v.descripcion, v.cantidad, v.precio, v.total,
            v.total - COALESCE((SELECT SUM(c.monto) FROM cobros_venta c WHERE c.venta_id = v.id AND c.anulado = 0), 0) AS saldo
     FROM ventas v WHERE v.negocio_id = ? AND v.anulado = 0 AND v.a_credito = 1 AND v.estado = 'pendiente'
     ORDER BY v.fecha, v.id`
  ).bind(negocioId).all();
  return results.map(v => ({ ...v, saldo: redondear2(Number(v.saldo)) })).filter(v => v.saldo > 0.005);
}

export async function cargarProformasConSaldo(db, negocioId) {
  const { results: docs } = await db.prepare(
    "SELECT id, numero, cliente, fecha, total FROM documentos WHERE negocio_id = ? AND tipo = 'proforma' AND estado != 'anulada' AND total IS NOT NULL"
  ).bind(negocioId).all();
  const { results: pagos } = await db.prepare(
    'SELECT documento_id, monto FROM pagos WHERE negocio_id = ? AND anulado = 0 AND documento_id IS NOT NULL'
  ).bind(negocioId).all();
  const saldos = calcularSaldos(docs, pagos);
  return docs.map(d => ({ ...d, saldo: saldos.get(d.id) }));
}

/** Lo que te deben hoy: fiados + préstamos + facturas proforma (igual que el reporte del bot). */
export async function calcularPorCobrar(db, negocioId) {
  const porCobrar = { fiado: 0, prestamos: 0, facturas: 0 };
  try {
    const cuadros = (await db.prepare('SELECT * FROM cuadros WHERE negocio_id = ?').bind(negocioId).all()).results;
    porCobrar.prestamos = suma(extraerPrestamosDeCuadros(cuadros, normalizarClave).items, 'saldo');
  } catch (e) { console.log('[WEB] Sin préstamos:', e?.message); }
  try { porCobrar.facturas = suma((await cargarProformasConSaldo(db, negocioId)).filter(d => d.saldo > 0.005), 'saldo'); } catch (e) { console.log('[WEB] Sin facturas:', e?.message); }
  try { porCobrar.fiado = suma(agruparDeudaVentas(await cargarVentasFiadasConSaldo(db, negocioId)), 'saldo'); } catch (e) { console.log('[WEB] Sin ventas a crédito:', e?.message); }
  return porCobrar;
}

/**
 * Cobrado en el período = ventas de contado + cobros de ventas fiadas + pagos y abonos registrados (facturas, préstamos).
 * Es plata que entró en esas fechas; no cuenta lo que quedó fiado.
 */
export async function calcularCobrado(db, negocioId, desde, hasta) {
  const contado = await db.prepare(
    'SELECT COALESCE(SUM(total), 0) AS t FROM ventas WHERE negocio_id = ? AND anulado = 0 AND COALESCE(a_credito, 0) = 0 AND fecha >= ? AND fecha <= ?'
  ).bind(negocioId, desde, hasta).first();
  let cobrosFiado = 0;
  try {
    cobrosFiado = (await db.prepare(
      'SELECT COALESCE(SUM(monto), 0) AS t FROM cobros_venta WHERE negocio_id = ? AND anulado = 0 AND fecha >= ? AND fecha <= ?'
    ).bind(negocioId, desde, hasta).first()).t;
  } catch (e) { console.log('[WEB] Sin cobros de ventas:', e?.message); }
  let pagos = 0;
  try {
    pagos = (await db.prepare(
      'SELECT COALESCE(SUM(monto), 0) AS t FROM pagos WHERE negocio_id = ? AND anulado = 0 AND fecha >= ? AND fecha <= ?'
    ).bind(negocioId, desde, hasta).first()).t;
  } catch (e) { console.log('[WEB] Sin pagos:', e?.message); }
  return { contado: redondear2(Number(contado.t)), cobrosFiado: redondear2(Number(cobrosFiado)), pagos: redondear2(Number(pagos)),
    total: redondear2(Number(contado.t) + Number(cobrosFiado) + Number(pagos)) };
}

/** Nombre a mostrar: el comercial si existe; si no, el del negocio. Nunca devuelve credenciales. */
export async function cargarEncabezado(db, negocioId) {
  const n = await db.prepare(
    `SELECT n.nombre AS nombre, c.nombre_comercial AS comercial
       FROM negocios n LEFT JOIN configuracion_negocio c ON c.negocio_id = n.id WHERE n.id = ?`
  ).bind(negocioId).first();
  let dueno = null;
  try {
    dueno = (await db.prepare(
      "SELECT nombre FROM telefonos_autorizados WHERE negocio_id = ? AND rol = 'dueno' AND activo = 1 AND nombre IS NOT NULL AND nombre != '' ORDER BY id LIMIT 1"
    ).bind(negocioId).first())?.nombre ?? null;
  } catch (e) { /* sin nombre del dueño */ }
  return { negocio: n?.comercial || n?.nombre || '', dueno };
}

/** Resumen del Inicio: ventas del mes (con comparación), te deben, cobrado y gastado. */
export async function resumenInicio(db, negocioId, ahora = new Date()) {
  const pedido = detectarPedidoReporte('reporte de este mes', ahora);
  const p = pedido.periodo;
  const { ventas, gastos } = await leerVentasYGastos(db, negocioId, p.desde, p.hasta);
  const pp = periodoAnterior(p);
  const previo = { periodo: pp, ...(await leerVentasYGastos(db, negocioId, pp.desde, pp.hasta)) };
  const porCobrar = await calcularPorCobrar(db, negocioId);
  const rep = calcularReporte({ periodo: p, ventas, gastos, fichas: [], porCobrar, productos: [], previo });
  const cobrado = await calcularCobrado(db, negocioId, p.desde, p.hasta);
  const enc = await cargarEncabezado(db, negocioId);
  const hayDatos = rep.ventasN > 0 || rep.gastosN > 0 || cobrado.total > 0.005 || (rep.porCobrar?.total ?? 0) > 0.005;
  return {
    ...enc,
    periodo: { desde: p.desde, hasta: p.hasta, etiqueta: p.etiqueta, anterior: pp.etiqueta },
    ventas: { total: rep.ventasTotal, n: rep.ventasN, aCredito: rep.aCredito, pctVsAnterior: rep.comparacion?.ventas?.pct ?? null, antes: rep.comparacion?.ventas?.antes ?? null },
    teDeben: { total: rep.porCobrar?.total ?? 0, fiado: porCobrar.fiado, prestamos: porCobrar.prestamos, facturas: porCobrar.facturas },
    cobrado,
    gastado: { total: rep.gastosTotal, n: rep.gastosN },
    hayDatos,
  };
}

export async function cargarPagosVigentes(db, negocioId) {
  const { results } = await db.prepare(
    `SELECT p.id, p.fecha, p.monto, p.tipo, p.documento_id, p.referencia, p.concepto, d.numero AS doc_numero
     FROM pagos p LEFT JOIN documentos d ON d.id = p.documento_id
     WHERE p.negocio_id = ? AND p.anulado = 0
     ORDER BY p.fecha DESC, p.id DESC LIMIT 500`
  ).bind(negocioId).all();
  return results;
}

/**
 * Pantalla Pagos: por cliente, lo que debe (préstamos + facturas proforma + ventas a crédito), su saldo a favor
 * y sus pagos recientes. Mismas fuentes que "¿quién me debe?" del bot.
 */
export async function resumenPagos(db, negocioId, ahora = new Date()) {
  const grupos = [];
  const grupo = (nombre) => {
    const n = String(nombre ?? '').trim() || '(sin nombre)';
    let g = grupos.find(x => (n === '(sin nombre)' || x.nombre === '(sin nombre)') ? x.nombre === n : mismoCliente(x.nombre, n));
    if (!g) { g = { nombre: n, deuda: 0, aFavor: 0, fuentes: [], pagos: [] }; grupos.push(g); }
    else if (n !== '(sin nombre)' && n.length > g.nombre.length) g.nombre = n;
    return g;
  };
  try {
    const cuadros = (await db.prepare('SELECT * FROM cuadros WHERE negocio_id = ?').bind(negocioId).all()).results;
    for (const it of extraerPrestamosDeCuadros(cuadros, normalizarClave).items) {
      const g = grupo(it.persona); g.deuda += it.saldo;
      g.fuentes.push({ tipo: 'prestamo', texto: `Préstamo · ${it.cuadro}`, fecha: null, saldo: it.saldo });
    }
  } catch (e) { console.log('[WEB] Pagos sin préstamos:', e?.message); }
  try {
    for (const d of (await cargarProformasConSaldo(db, negocioId)).filter(x => x.saldo > 0.005)) {
      const g = grupo(d.cliente); g.deuda += d.saldo;
      g.fuentes.push({ tipo: 'factura', texto: `Factura proforma ${d.numero}`, fecha: d.fecha, saldo: redondear2(d.saldo) });
    }
  } catch (e) { console.log('[WEB] Pagos sin facturas:', e?.message); }
  try {
    for (const v of await cargarVentasFiadasConSaldo(db, negocioId)) {
      const g = grupo(v.cliente_nombre); g.deuda += v.saldo;
      g.fuentes.push({ tipo: 'fiado', texto: `Venta a crédito${v.descripcion ? ' · ' + v.descripcion : ''}`, fecha: v.fecha, saldo: v.saldo });
    }
  } catch (e) { console.log('[WEB] Pagos sin ventas a crédito:', e?.message); }
  let pagos = [];
  try { pagos = await cargarPagosVigentes(db, negocioId); } catch (e) { console.log('[WEB] Pagos sin pagos:', e?.message); }
  for (const f of agruparSaldosAFavor(pagos)) grupo(f.cliente).aFavor += f.monto;
  for (const p of pagos) {
    if (!String(p.referencia ?? '').trim()) continue;
    const g = grupo(p.referencia);
    if (g.pagos.length < 30) g.pagos.push({
      fecha: p.fecha, monto: redondear2(Number(p.monto)), tipo: p.tipo,
      concepto: p.tipo === 'cobro_documento' && p.doc_numero ? `Pago de la factura proforma ${p.doc_numero}` : (p.concepto || ''),
    });
  }
  const clientes = grupos.map(g => {
    const deuda = redondear2(g.deuda); const aFavor = redondear2(g.aFavor);
    return { ...g, deuda, aFavor, estado: deuda > 0.005 ? 'Pendiente' : aFavor > 0.005 ? 'A favor' : 'Al día' };
  }).sort((a, b) => b.deuda - a.deuda || b.aFavor - a.aFavor || a.nombre.localeCompare(b.nombre, 'es'))
    .map((g, i) => ({ id: i, ...g }));
  const p = detectarPedidoReporte('reporte de este mes', ahora).periodo;
  const cobrado = await calcularCobrado(db, negocioId, p.desde, p.hasta);
  return {
    periodo: { desde: p.desde, hasta: p.hasta },
    resumen: {
      teDeben: redondear2(clientes.reduce((s, c) => s + c.deuda, 0)),
      aFavor: redondear2(clientes.reduce((s, c) => s + c.aFavor, 0)),
      cobradoMes: cobrado.total,
    },
    clientes,
  };
}

// Fecha (YYYY-MM-DD) en Panamá (UTC-5) de un created_at de D1 (UTC, "YYYY-MM-DD HH:MM:SS")
export function fechaPanamaDeCreado(creado) {
  const t = Date.parse(String(creado ?? '').replace(' ', 'T') + (String(creado ?? '').includes('Z') ? '' : 'Z'));
  return Number.isFinite(t) ? new Date(t - 5 * 3600 * 1000).toISOString().slice(0, 10) : null;
}

/**
 * Pantalla Inventario: cada producto con su stock (suma de movimientos vigentes), su mínimo y sus últimos
 * movimientos. Misma fuente y misma regla de "poco inventario" que el reporte del bot.
 */
export async function resumenInventario(db, negocioId) {
  const productos = await cargarProductosInventario(db, negocioId);
  let movs = [];
  try {
    movs = (await db.prepare(
      `SELECT producto_id, tipo, cantidad, created_at FROM inventario_movimientos
        WHERE negocio_id = ? AND anulado = 0 ORDER BY created_at DESC, id DESC LIMIT 600`
    ).bind(negocioId).all()).results;
  } catch (e) { console.log('[WEB] Inventario sin movimientos:', e?.message); }
  const porProducto = new Map();
  for (const m of movs) {
    const l = porProducto.get(m.producto_id) || [];
    if (l.length < 15) l.push({ fecha: fechaPanamaDeCreado(m.created_at), tipo: m.tipo, cantidad: redondear2(Number(m.cantidad)) });
    porProducto.set(m.producto_id, l);
  }
  const lista = productos.map(p => {
    const bajo = p.stock < -0.0001 || (p.minimo !== null && p.stock <= p.minimo + 0.0001);
    return {
      nombre: p.producto, stock: p.stock, minimo: p.minimo,
      estado: p.stock < -0.0001 ? 'Revisar' : bajo ? 'Poco inventario' : 'Bien',
      movimientos: porProducto.get(p.id) || [],
    };
  }).sort((a, b) => (a.estado === 'Bien') - (b.estado === 'Bien') || a.nombre.localeCompare(b.nombre, 'es'))
    .map((p, i) => ({ id: i, ...p }));
  return { resumen: { productos: lista.length, bajos: lista.filter(p => p.estado !== 'Bien').length }, productos: lista };
}

// ── Pantalla Informes ─────────────────────────────────────────────────────────────────────────────
const NOMBRES_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const isoDe = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const ultimoDia = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const sumarDiasIso = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const f = new Date(Date.UTC(y, m - 1, d + n)); return isoDe(f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate()); };
const diasEntreIso = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const esFechaIso = s => ISO_RE.test(String(s ?? '')) && isoDe(...String(s).split('-').map(Number)) === s && Number(s.slice(5, 7)) >= 1 && Number(s.slice(5, 7)) <= 12 && Number(s.slice(8)) <= ultimoDia(Number(s.slice(0, 4)), Number(s.slice(5, 7)));

/** Período pedido por la pantalla: 'mes' | 'mes_pasado' | '3meses' | 'personalizado' (con desde/hasta). {error} si no vale. */
export function periodoInforme(rango, desde, hasta, ahora = new Date()) {
  const hoy = fechaIsoPanama(ahora);
  const [y, m] = hoy.split('-').map(Number);
  if (rango === 'mes') return detectarPedidoReporte('reporte de este mes', ahora).periodo;
  if (rango === 'mes_pasado') {
    const pm = m === 1 ? 12 : m - 1; const py = m === 1 ? y - 1 : y;
    return { desde: isoDe(py, pm, 1), hasta: isoDe(py, pm, ultimoDia(py, pm)), etiqueta: `${NOMBRES_MES[pm - 1]} ${py}` };
  }
  if (rango === '3meses') {
    const d = new Date(Date.UTC(y, m - 3, 1));
    return { desde: isoDe(d.getUTCFullYear(), d.getUTCMonth() + 1, 1), hasta: hoy, etiqueta: 'los últimos 3 meses' };
  }
  if (rango === 'personalizado') {
    if (!esFechaIso(desde) || !esFechaIso(hasta)) return { error: 'Escoge la fecha inicial y la final.' };
    if (desde > hasta) return { error: 'La fecha inicial es posterior a la final.' };
    if (desde > hoy) return { error: 'Ese rango todavía no ha llegado. Escoge uno que ya haya pasado.' };
    const h = hasta > hoy ? hoy : hasta;
    if (diasEntreIso(desde, h) > 366) return { error: 'El rango máximo es de un año.' };
    return { desde, hasta: h, etiqueta: 'período personalizado' };
  }
  return { error: 'Período no válido.' };
}

/** Ventas y gastos por semana (rangos de hasta 35 días: bloques de 7 días desde el inicio) o por mes. */
export function serieInforme(ventas, gastos, p) {
  const cortes = [];
  if (diasEntreIso(p.desde, p.hasta) + 1 <= 35) {
    for (let d = p.desde; d <= p.hasta; d = sumarDiasIso(d, 7)) { const h = sumarDiasIso(d, 6); cortes.push([d, h > p.hasta ? p.hasta : h]); }
  } else {
    let [y, m] = p.desde.split('-').map(Number);
    for (;;) {
      const ini = isoDe(y, m, 1); const fin = isoDe(y, m, ultimoDia(y, m));
      if (ini > p.hasta) break;
      cortes.push([ini < p.desde ? p.desde : ini, fin > p.hasta ? p.hasta : fin]);
      if (m === 12) { y++; m = 1; } else m++;
    }
  }
  const puntos = cortes.map(([desde, hasta]) => ({
    desde, hasta,
    ventas: suma(ventas.filter(v => v.fecha >= desde && v.fecha <= hasta), 'total'),
    gastos: suma(gastos.filter(g => g.fecha >= desde && g.fecha <= hasta), 'monto'),
  }));
  return { tipo: cortes.length && diasEntreIso(p.desde, p.hasta) + 1 <= 35 ? 'semana' : 'mes', puntos };
}

function topGastos(gastos, n = 5) {
  const g = new Map();
  for (const x of gastos) {
    const k = claveProducto(x.descripcion) || String(x.descripcion ?? '').trim().toLowerCase();
    if (!k) continue;
    const a = g.get(k) || { nombre: String(x.descripcion ?? '').trim(), total: 0 };
    a.total += Number(x.monto || 0);
    if (String(x.descripcion ?? '').trim().length > a.nombre.length) a.nombre = String(x.descripcion).trim();
    g.set(k, a);
  }
  return [...g.values()].map(a => ({ nombre: a.nombre, total: redondear2(a.total) })).sort((a, b) => b.total - a.total).slice(0, n);
}

/**
 * Pantalla Informes: las mismas cifras del reporte del bot (calcularReporte) para el período elegido,
 * más la comparación con el período anterior, la serie para las barras y lo que más se vendió / gastó.
 */
export async function resumenInforme(db, negocioId, { rango, desde, hasta } = {}, ahora = new Date()) {
  const p = periodoInforme(rango, desde, hasta, ahora);
  if (p.error) return { error: p.error };
  const { ventas, gastos } = await leerVentasYGastos(db, negocioId, p.desde, p.hasta);
  let fichas = [];
  try { fichas = await cargarFichasCosto(db, negocioId); } catch (e) { console.log('[WEB] Informe sin fichas de costo:', e?.message); }
  let porCobrar = { fiado: 0, prestamos: 0, facturas: 0 };
  try { porCobrar = await calcularPorCobrar(db, negocioId); } catch (e) { console.log('[WEB] Informe sin por cobrar:', e?.message); }
  let productos = [];
  try { productos = await cargarProductosInventario(db, negocioId); } catch (e) { console.log('[WEB] Informe sin inventario:', e?.message); }
  const pp = periodoAnterior(p);
  const previo = { periodo: pp, ...(await leerVentasYGastos(db, negocioId, pp.desde, pp.hasta)) };
  let cobrado = null;
  try { cobrado = await calcularCobrado(db, negocioId, p.desde, p.hasta); } catch (e) { console.log('[WEB] Informe sin cobrado:', e?.message); }
  const rep = calcularReporte({ periodo: p, ventas, gastos, fichas, porCobrar, productos, previo, cobrado });
  return {
    periodo: { desde: p.desde, hasta: p.hasta, etiqueta: p.etiqueta, anterior: pp.etiqueta },
    ventas: { total: rep.ventasTotal, n: rep.ventasN, aCredito: rep.aCredito, antes: rep.comparacion.ventas.antes, pct: rep.comparacion.ventas.pct },
    gastos: { total: rep.gastosTotal, n: rep.gastosN, antes: rep.comparacion.gastos.antes, pct: rep.comparacion.gastos.pct },
    diferencia: rep.diferencia,
    ganancia: rep.ganancia ? { total: rep.ganancia.ganancia, pct: rep.comparacion.ganancia?.pct ?? null, ventasSinCosto: rep.ganancia.ventasSinCosto } : null,
    cobrado,
    porCobrar: rep.porCobrar,
    inventarioBajo: rep.inventario ? rep.inventario.bajos : [],
    serie: serieInforme(ventas, gastos, p),
    topVentas: topProductos(ventas, 5),
    topGastos: topGastos(gastos, 5),
    hayDatos: rep.ventasN > 0 || rep.gastosN > 0 || (cobrado?.total ?? 0) > 0.005,
  };
}

// ── Pantalla Documentos: historial de cartas generadas (sin descarga: los archivos no se guardan todavía) ──
const jsonSeguro = (s, defecto) => { try { const v = JSON.parse(s); return v ?? defecto; } catch { return defecto; } };

export async function resumenDocumentos(db, negocioId, ahora = new Date()) {
  let filas = [];
  try {
    filas = (await db.prepare(
      'SELECT id, tipo, nombre, formato, solicitud, fecha FROM documentos_generados WHERE negocio_id = ? ORDER BY id DESC LIMIT 200'
    ).bind(negocioId).all()).results;
  } catch (e) { console.log('[WEB] Documentos sin historial:', e?.message); }
  const etiquetas = new Map();
  try {
    for (const pl of (await db.prepare('SELECT id, campos_requeridos, campos_opcionales FROM plantillas_carta').all()).results) {
      const m = new Map();
      for (const c of [...jsonSeguro(pl.campos_requeridos, []), ...jsonSeguro(pl.campos_opcionales, [])]) if (c?.id) m.set(c.id, c.etiqueta || c.id);
      etiquetas.set(pl.id, m);
    }
  } catch (e) { console.log('[WEB] Documentos sin plantillas:', e?.message); }
  const recorta = (v, n) => { const s = String(v ?? '').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const docs = filas.map((f, i) => {
    const campos = jsonSeguro(f.solicitud, {});
    const lista = (campos && typeof campos === 'object' ? Object.entries(campos) : [])
      .filter(([k, v]) => !/cedula/i.test(k) && v !== null && v !== undefined && String(v).trim() !== '')
      .map(([k, v]) => ({ etiqueta: etiquetas.get(f.tipo)?.get(k) || k.replace(/_/g, ' '), valor: recorta(v, 2000) }));
    return {
      id: i, nombre: String(f.nombre || f.tipo || 'Documento'), formato: String(f.formato || ''),
      fecha: fechaPanamaDeCreado(f.fecha),
      para: recorta(campos?.destinatario ?? '', 120), asunto: recorta(campos?.asunto ?? '', 160),
      campos: lista,
    };
  });
  const mes = fechaIsoPanama(ahora).slice(0, 7);
  return { resumen: { total: docs.length, esteMes: docs.filter(d => (d.fecha || '').startsWith(mes)).length }, documentos: docs };
}