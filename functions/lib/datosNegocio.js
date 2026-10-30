// functions/lib/datosNegocio.js
// Datos del negocio para la oficina web (SOLO LECTURA). Reutiliza las mismas funciones de cálculo que el bot
// (reportes.js, pagos.js, ventasGastos.js) para que una cifra tenga una sola verdad: lo que dice WhatsApp y
// lo que dice la web coinciden. Todo se filtra por negocio_id, que sale de la sesión, nunca del navegador.

import { redondear2, calcularSaldos, extraerPrestamosDeCuadros, agruparSaldosAFavor, mismoCliente } from './pagos.js';
import { agruparDeudaVentas } from './ventasGastos.js';
import { calcularReporte, detectarPedidoReporte, periodoAnterior } from './reportes.js';

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