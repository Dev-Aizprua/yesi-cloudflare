// functions/lib/reportes.js
// Reporte general del negocio: "¿Cómo va mi negocio este mes?". Lógica PURA, sin base de datos ni WhatsApp.
// Principios (los mismos de todo el proyecto): el reporte lo arma el CÓDIGO con lo que ya existe (ventas, gastos,
// costos, fiados/préstamos/facturas por cobrar, inventario); 0 tokens de Groq; todas las cuentas las hace el código.
// El mensaje lleva el período con fechas (línea "Del … al …"): de ahí se recupera para "mándamelo en PDF" y "compáralo".

import { redondear2, formatoMonto, fechaLegible, fechaIsoPanama } from './pagos.js';
import { periodoDesdeTexto } from './ventasGastos.js';
import { claveProducto, emparejarCosto } from './costos.js';

const sinTildes = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const plano = t => sinTildes(t).replace(/[¿?¡!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();

export const ENCABEZADO_REPORTE = '📊 Tu negocio';

// ── Fechas ────────────────────────────────────────────────────────────────────────────────────────
const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const NOMBRE_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const isoDe = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const ultimoDiaMes = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function sumarDias(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const f = new Date(Date.UTC(y, m - 1, d + n));
  return isoDe(f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate());
}
const diasEntre = (a, b) => Math.round((Date.UTC(...b.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x)))) - Date.UTC(...a.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))))) / 86400000);
const fechaValida = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= ultimoDiaMes(y, m);

/** Año del mes dicho: si el mes es posterior al actual se entiende el del año pasado (igual que periodoDesdeTexto). */
function anioDeMes(m, hoy) {
  const [y, mh] = hoy.split('-').map(Number);
  return m > mh ? y - 1 : y;
}

/**
 * "del 1 al 15 de octubre", "del 5 de octubre al 20 de octubre", "entre el 1 y el 15 de octubre", "del 1 al 15",
 * "del 01/10 al 15/10". @returns {{ desde, hasta, etiqueta } | { error: string } | null}
 */
export function detectarRango(texto, ahora = new Date()) {
  const t = plano(texto);
  const hoy = fechaIsoPanama(ahora);
  const [yh, mh] = hoy.split('-').map(Number);
  let desde = null;
  let hasta = null;
  let m = t.match(/\b(?:del|desde el|desde|entre el|entre)\s+(\d{1,2})\s+de\s+([a-z]+)\s+(?:al|hasta el|hasta|y el|y)\s+(\d{1,2})\s+de\s+([a-z]+)\b/);
  if (m && MESES[m[2]] && MESES[m[4]]) {
    const m1 = MESES[m[2]]; const m2 = MESES[m[4]];
    const y2 = anioDeMes(m2, hoy); const y1 = m1 > m2 ? y2 - 1 : y2;
    desde = [y1, m1, Number(m[1])]; hasta = [y2, m2, Number(m[3])];
  }
  if (!desde) {
    m = t.match(/\b(?:del|desde el|desde|entre el|entre)\s+(\d{1,2})\s+(?:al|hasta el|hasta|y el|y)\s+(\d{1,2})(?:\s+de\s+([a-z]+))?\b/);
    if (m) {
      const mes = m[3] ? MESES[m[3]] : mh;
      if (m[3] && !mes) return null;
      const y = m[3] ? anioDeMes(mes, hoy) : yh;
      desde = [y, mes, Number(m[1])]; hasta = [y, mes, Number(m[2])];
    }
  }
  if (!desde) {
    m = t.match(/\b(?:del|desde el|desde)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(?:al|hasta el|hasta)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (m) {
      const an = v => (v ? (v.length === 2 ? 2000 + Number(v) : Number(v)) : yh);
      desde = [an(m[3]), Number(m[2]), Number(m[1])]; hasta = [an(m[6]), Number(m[5]), Number(m[4])];
    }
  }
  if (!desde) return null;
  if (!fechaValida(...desde) || !fechaValida(...hasta)) return { error: 'Esas fechas no existen en el calendario. Dímelas de nuevo, por ejemplo: "del 1 al 15 de octubre".' };
  let d = isoDe(...desde); let h = isoDe(...hasta);
  if (d > h) return { error: 'La fecha de inicio es posterior a la final. Dímelo de nuevo, por ejemplo: "del 1 al 15 de octubre".' };
  if (d > hoy) return { error: 'Ese rango todavía no ha llegado. Dime uno que ya haya pasado.' };
  if (h > hoy) h = hoy;
  return { desde: d, hasta: h, etiqueta: `del ${fechaLegible(d)} al ${fechaLegible(h)}` };
}

/**
 * Período inmediatamente anterior, comparable: un mes (parcial o completo) contra el mes anterior con los mismos días;
 * cualquier otro período contra el tramo de igual duración justo antes.
 */
export function periodoAnterior(p) {
  const [y, m, d1] = p.desde.split('-').map(Number);
  const [y2, m2, d2] = p.hasta.split('-').map(Number);
  const dias = diasEntre(p.desde, p.hasta) + 1;
  if (d1 === 1 && y === y2 && m === m2) {
    const pm = m === 1 ? 12 : m - 1; const py = m === 1 ? y - 1 : y;
    const ultimo = ultimoDiaMes(py, pm);
    const completo = d2 === ultimoDiaMes(y, m);
    const hasta = completo ? ultimo : Math.min(d2, ultimo);
    return { desde: isoDe(py, pm, 1), hasta: isoDe(py, pm, hasta), etiqueta: completo ? `${NOMBRE_MES[pm - 1]} ${py}` : `el mes pasado (del 01/${String(pm).padStart(2, '0')} al ${String(hasta).padStart(2, '0')}/${String(pm).padStart(2, '0')})` };
  }
  const hasta = sumarDias(p.desde, -1);
  const desde = sumarDias(p.desde, -dias);
  return { desde, hasta, etiqueta: dias === 1 ? `el día anterior (${fechaLegible(desde)})` : `el período anterior (${fechaLegible(desde)} al ${fechaLegible(hasta)})` };
}

// ── Detección ─────────────────────────────────────────────────────────────────────────────────────
const RE_PERIODO = /\b(hoy|ayer|semana|mes|ano)\b/;
const RE_MES_NOMBRE = new RegExp(`\\b(${Object.keys(MESES).join('|')})\\b`);
const RE_OTRO_TEMA = /\b(excel|cuadro|cuadros|factura|facturas|cotizacion|cotizaciones|proforma|imagen|foto|deuda|deudas|cobros|cobrar|debe|deben|inventario|stock|costos|costo|ganancia|ganancias|carta|anul\w*|elimin\w*|borr\w*|registr\w*|agreg\w*|crea\w*)\b/;

/**
 * "¿Cómo va mi negocio este mes?", "reporte del mes", "resumen del negocio", "¿cómo me fue la semana pasada?",
 * "reporte del 1 al 15 de octubre", "balance de hoy en pdf", "compara mi negocio con el mes pasado".
 * @returns {{ periodo: {desde, hasta, etiqueta}, comparar: boolean, pdf: boolean } | { error: string } | null}
 */
export function detectarPedidoReporte(texto, ahora = new Date()) {
  const t = plano(texto);
  if (!t || t.length > 120 || /\d{4,}/.test(t.replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, ''))) return null;
  if (RE_OTRO_TEMA.test(t.replace(/\bpdf\b/g, ''))) return null;
  const negocio = /\b(negocio|empresa|tienda|todo)\b/.test(t);
  const periodoDicho = RE_PERIODO.test(t) || RE_MES_NOMBRE.test(t) || /\b(?:del|desde el|desde|entre el|entre)\s+\d{1,2}\b/.test(t);
  const como = /\bcomo\s+(?:va|vamos|voy|anda|marcha|esta|me va|me fue|nos fue|me ha ido|nos ha ido|me esta yendo)\b/.test(t);
  const palabraReporte = /\b(reporte|informe|resumen|balance)\b/.test(t);
  const estado = /\b(estado|situacion|panorama)\s+(?:de|del)\s+(?:mi\s+)?negocio\b/.test(t);
  const compara = /\b(compar\w*|versus|vs|frente a|contra)\b/.test(t);
  let vale = false;
  if (como && (negocio || periodoDicho) && t.split(" ").length <= 14) vale = true;
  else if (palabraReporte && (negocio || periodoDicho || /\bgeneral|mensual|semanal|diario\b/.test(t))) vale = true;
  else if (estado) vale = true;
  else if (compara && negocio) vale = true;
  if (!vale) return null;
  const rango = detectarRango(texto, ahora);
  if (rango && rango.error) return { error: rango.error };
  let periodo;
  if (rango) periodo = rango;
  else if (periodoDicho) periodo = periodoDesdeTexto(t, ahora);
  else periodo = periodoDesdeTexto('este mes', ahora);
  return { periodo, comparar: compara, pdf: /\bpdf\b/.test(t) };
}

/** Seguimiento corto tras un reporte: "mándamelo en PDF", "compáralo con el mes pasado". @returns {{ pdf?: true, comparar?: true } | null} */
export function detectarSeguimientoReporte(texto) {
  const t = plano(texto);
  if (!t || t.length > 60) return null;
  if (/^(?:(?:mandamelo|mandamela|pasamelo|pasamela|envialo|enviamelo|enviala|dame(?:lo)?|hazme(?:lo)?|ponlo|quiero(?:lo)?|mandame|pasame|enviame)\s+)?(?:(?:el|la|ese|esa)\s+)?(?:(?:reporte|informe|resumen)\s+)?(?:en|como)\s+pdf$/.test(t)
    || /^(?:el\s+)?pdf(?:\s+por favor)?$/.test(t) || /^(?:mandamelo|pasamelo|envialo|enviamelo|dame(?:lo)?)\s+(?:en\s+)?pdf$/.test(t)) return { pdf: true };
  if (/^compar\w*(?:lo|la)?(?:\s+(?:con|contra|vs)\s+(?:el\s+|la\s+)?(?:mes pasado|mes anterior|periodo anterior|anterior|semana pasada|semana anterior|ayer|antes))?$/.test(t)
    || /^(?:como|cuanto)\s+(?:voy|va|estoy|estamos)\s+(?:comparado|vs|versus|contra)\b/.test(t)) return { comparar: true };
  return null;
}

/** Del último mensaje de reporte recupera el período ("Del 01/10/2026 al 23/10/2026"). @returns {{ desde, hasta, etiqueta } | null} */
export function periodoDelMensajeDeReporte(mensaje) {
  const s = String(mensaje ?? '');
  if (!s.startsWith(ENCABEZADO_REPORTE)) return null;
  const f = s.match(/Del (\d{2})\/(\d{2})\/(\d{4}) al (\d{2})\/(\d{2})\/(\d{4})/);
  if (!f) return null;
  const e = s.split('\n')[0].match(/—\s*(.+)$/);
  return { desde: `${f[3]}-${f[2]}-${f[1]}`, hasta: `${f[6]}-${f[5]}-${f[4]}`, etiqueta: e ? e[1].trim() : `del ${f[1]}/${f[2]}/${f[3]} al ${f[4]}/${f[5]}/${f[6]}` };
}

// ── Cálculos ──────────────────────────────────────────────────────────────────────────────────────
const suma = (arr, k) => redondear2((arr || []).reduce((s, x) => s + Number(x[k] || 0), 0));

/** Ganancia = ventas con costo guardado − (cantidad × costo por unidad). null si no hay fichas de costo. */
export function gananciaDe(ventas, fichas) {
  if (!fichas || fichas.length === 0) return null;
  let vendido = 0; let costo = 0; let sinCosto = 0;
  const sin = new Set();
  for (const v of ventas || []) {
    const f = emparejarCosto(v.descripcion, fichas);
    if (!f) { sinCosto++; sin.add(claveProducto(v.descripcion)); continue; }
    vendido += Number(v.total || 0);
    costo += Number(v.cantidad || 0) * Number(f.costo_unidad);
  }
  vendido = redondear2(vendido); costo = redondear2(costo);
  return { vendido, costo, ganancia: redondear2(vendido - costo), ventasSinCosto: sinCosto, productosSinCosto: sin.size, conCosto: (ventas || []).length - sinCosto };
}

/** Los 3 productos que más dinero dejaron en el período (agrupa singular/plural). */
export function topProductos(ventas, n = 3) {
  const g = new Map();
  for (const v of ventas || []) {
    const k = claveProducto(v.descripcion);
    if (!k) continue;
    const x = g.get(k) || { nombre: String(v.descripcion ?? '').trim(), total: 0, cantidad: 0 };
    x.total += Number(v.total || 0);
    x.cantidad += Number(v.cantidad || 0);
    if (String(v.descripcion ?? '').trim().length > x.nombre.length) x.nombre = String(v.descripcion).trim();
    g.set(k, x);
  }
  return [...g.values()].map(x => ({ ...x, total: redondear2(x.total), cantidad: redondear2(x.cantidad) })).sort((a, b) => b.total - a.total).slice(0, n);
}

const pct = (act, prev) => (prev > 0 ? Math.round(((act - prev) / prev) * 100) : null);

/**
 * @param {{ periodo, ventas, gastos, fichas, porCobrar?: { fiado: number, prestamos: number, facturas: number },
 *           productos?: Array<{producto, stock, minimo}>, previo?: { periodo, ventas, gastos } }} d
 */
export function calcularReporte(d) {
  const ventas = d.ventas || []; const gastos = d.gastos || [];
  const rep = {
    periodo: d.periodo,
    ventasTotal: suma(ventas, 'total'), ventasN: ventas.length,
    aCredito: suma(ventas.filter(v => Number(v.a_credito) === 1), 'total'),
    gastosTotal: suma(gastos, 'monto'), gastosN: gastos.length,
    ganancia: gananciaDe(ventas, d.fichas),
    top: topProductos(ventas),
    porCobrar: null, inventario: null, comparacion: null,
  };
  rep.diferencia = redondear2(rep.ventasTotal - rep.gastosTotal);
  if (d.porCobrar) {
    const p = d.porCobrar;
    rep.porCobrar = { fiado: redondear2(p.fiado || 0), prestamos: redondear2(p.prestamos || 0), facturas: redondear2(p.facturas || 0) };
    rep.porCobrar.total = redondear2(rep.porCobrar.fiado + rep.porCobrar.prestamos + rep.porCobrar.facturas);
  }
  if (d.productos && d.productos.length > 0) {
    const bajos = d.productos.filter(p => Number(p.stock) < -0.0001 || (p.minimo !== null && p.minimo !== undefined && Number(p.stock) <= Number(p.minimo) + 0.0001))
      .map(p => ({ producto: p.producto, stock: redondear2(Number(p.stock)) }));
    rep.inventario = { n: d.productos.length, bajos };
  }
  if (d.previo) {
    const pv = d.previo.ventas || []; const pg = d.previo.gastos || [];
    const vPrev = suma(pv, 'total'); const gPrev = suma(pg, 'monto');
    const gananciaPrev = gananciaDe(pv, d.fichas);
    rep.comparacion = {
      etiqueta: d.previo.periodo.etiqueta,
      ventas: { antes: vPrev, pct: pct(rep.ventasTotal, vPrev) },
      gastos: { antes: gPrev, pct: pct(rep.gastosTotal, gPrev) },
      ganancia: rep.ganancia && gananciaPrev ? { antes: gananciaPrev.ganancia, pct: pct(rep.ganancia.ganancia, gananciaPrev.ganancia) } : null,
    };
  }
  return rep;
}

const flecha = p => (p === null ? 'sin datos antes' : p > 0 ? `+${p}%` : p < 0 ? `${p}%` : 'igual');
const vsAntes = (c, ) => (c.pct === null ? 'sin datos antes' : `${flecha(c.pct)} (antes ${formatoMonto(c.antes)})`);
const plural = (n, a, b) => (n === 1 ? a : b);

function lineasComparacion(c) {
  const l = [`Comparado con ${c.etiqueta}:`];
  l.push(`• Ventas: ${vsAntes(c.ventas)}`);
  l.push(`• Gastos: ${vsAntes(c.gastos)}`);
  if (c.ganancia) l.push(`• Ganancia estimada: ${vsAntes(c.ganancia)}`);
  return l;
}

export function textoReporte(rep) {
  const p = rep.periodo;
  const l = [`${ENCABEZADO_REPORTE} — ${p.etiqueta}`, `Del ${fechaLegible(p.desde)} al ${fechaLegible(p.hasta)}`, ''];
  if (rep.ventasN === 0 && rep.gastosN === 0) {
    l.push('No hay ventas ni gastos registrados en ese período.');
  } else {
    l.push(`💰 Ventas: ${formatoMonto(rep.ventasTotal)} (${rep.ventasN} ${plural(rep.ventasN, 'venta', 'ventas')})`);
    if (rep.aCredito > 0.005) l.push(`   ↳ a crédito: ${formatoMonto(rep.aCredito)}`);
    l.push(`💸 Gastos: ${formatoMonto(rep.gastosTotal)} (${rep.gastosN} ${plural(rep.gastosN, 'gasto', 'gastos')})`);
    l.push(`📈 Diferencia (ventas − gastos): ${formatoMonto(rep.diferencia)}`);
    if (rep.ganancia === null) l.push('🧾 Ganancia estimada: guarda el costo de tus productos para verla (ej. "El jugo cuesta: frutas 8, azúcar 2").');
    else if (rep.ganancia.conCosto === 0) l.push('🧾 Ganancia estimada: ninguna venta de este período tiene costo guardado.');
    else l.push(`🧾 Ganancia estimada: ${formatoMonto(rep.ganancia.ganancia)}${rep.ganancia.productosSinCosto > 0 ? ` (sin contar ${rep.ganancia.productosSinCosto} ${plural(rep.ganancia.productosSinCosto, 'producto sin costo', 'productos sin costo')})` : ''}`);
  }
  if (rep.porCobrar) {
    const c = rep.porCobrar;
    if (c.total > 0.005) {
      const partes = [];
      if (c.fiado > 0.005) partes.push(`fiados ${c.fiado.toFixed(2)}`);
      if (c.prestamos > 0.005) partes.push(`préstamos ${c.prestamos.toFixed(2)}`);
      if (c.facturas > 0.005) partes.push(`facturas ${c.facturas.toFixed(2)}`);
      l.push(`🤝 Por cobrar hoy: ${formatoMonto(c.total)} — ${partes.join(' · ')}`);
    } else {
      l.push('🤝 Por cobrar hoy: nada pendiente.');
    }
  }
  if (rep.inventario) {
    const i = rep.inventario;
    if (i.bajos.length === 0) l.push(`📦 Inventario: ${i.n} ${plural(i.n, 'producto', 'productos')}, ninguno en el mínimo.`);
    else l.push(`📦 Inventario: ⚠️ stock bajo en ${i.bajos.length} de ${i.n}: ${i.bajos.slice(0, 5).map(b => `${b.producto} (${b.stock})`).join(', ')}${i.bajos.length > 5 ? ', …' : ''}`);
  }
  if (rep.top.length > 0) l.push(`🏆 Más vendidos: ${rep.top.map((x, k) => `${k + 1}. ${x.nombre} ${formatoMonto(x.total)}`).join(' · ')}`);
  if (rep.comparacion) l.push('', ...lineasComparacion(rep.comparacion));
  l.push('', 'La diferencia no es la ganancia: no descuenta el costo de los productos. Para el detalle: "quién me debe", "mi inventario", "cuánto gané".');
  l.push(rep.comparacion ? 'Para el PDF di "mándamelo en PDF".' : 'Di "mándamelo en PDF" o "compáralo con el mes pasado".');
  return l.join('\n');
}

/** Filas {concepto, valor} para el PDF (se arma con el mismo generador de tablas de los cuadros). */
export function filasPdfReporte(rep) {
  const f = [];
  const fila = (concepto, valor) => f.push({ concepto, valor });
  fila('VENTAS Y GASTOS', '');
  fila('Ventas', `${formatoMonto(rep.ventasTotal)} (${rep.ventasN})`);
  if (rep.aCredito > 0.005) fila('   de ellas a crédito', formatoMonto(rep.aCredito));
  fila('Gastos', `${formatoMonto(rep.gastosTotal)} (${rep.gastosN})`);
  fila('Diferencia (ventas − gastos)', formatoMonto(rep.diferencia));
  fila('GANANCIA ESTIMADA', '');
  fila('Ganancia (productos con costo)', rep.ganancia && rep.ganancia.conCosto > 0 ? formatoMonto(rep.ganancia.ganancia) : 'sin costos guardados');
  if (rep.porCobrar) {
    fila('POR COBRAR (hoy)', '');
    fila('Ventas a crédito (fiados)', formatoMonto(rep.porCobrar.fiado));
    fila('Préstamos', formatoMonto(rep.porCobrar.prestamos));
    fila('Facturas', formatoMonto(rep.porCobrar.facturas));
    fila('Total por cobrar', formatoMonto(rep.porCobrar.total));
  }
  if (rep.inventario) {
    fila('INVENTARIO', '');
    fila('Productos registrados', String(rep.inventario.n));
    fila('Con stock bajo', rep.inventario.bajos.length ? rep.inventario.bajos.map(b => `${b.producto} (${b.stock})`).join(', ') : 'ninguno');
  }
  if (rep.top.length) {
    fila('MÁS VENDIDOS', '');
    rep.top.forEach((x, k) => fila(`${k + 1}. ${x.nombre}`, `${formatoMonto(x.total)} (${x.cantidad})`));
  }
  if (rep.comparacion) {
    fila(`COMPARADO CON ${rep.comparacion.etiqueta.toUpperCase()}`, '');
    fila('Ventas', vsAntes(rep.comparacion.ventas));
    fila('Gastos', vsAntes(rep.comparacion.gastos));
    if (rep.comparacion.ganancia) fila('Ganancia estimada', vsAntes(rep.comparacion.ganancia));
  }
  return f;
}