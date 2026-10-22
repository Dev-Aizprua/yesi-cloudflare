// functions/lib/costos.js
// Costos de productos (fichas de costo) y ganancia estimada. Lógica PURA, sin base de datos ni WhatsApp.
// Principios (los mismos de todo el proyecto): Groq solo extrae valores crudos (producto, componentes, montos);
// el código suma, divide y compara. Nada se guarda sin vista previa y "sí". Una ficha nueva del mismo producto
// reemplaza a la anterior, pero la anterior queda en el historial (vigente = 0); no se borra.

import { redondear2, formatoMonto, parsearMonto, fechaLegible } from './pagos.js';
import { periodoDesdeTexto } from './ventasGastos.js';

export const MAX_COMPONENTES = 15;
const sinTildes = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const plano = t => sinTildes(t).replace(/[¿?¡!.,;:"“”]/g, ' ').replace(/\s+/g, ' ').trim();
const limpiar = (t, max) => String(t ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const ARTICULOS = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'mi', 'mis']);

function singular(p) {
  if (p.length > 4 && /[lnrdzj]es$/.test(p)) return p.slice(0, -2);
  if (p.length > 3 && p.endsWith('s')) return p.slice(0, -1);
  return p;
}

/** "Los Jugos artesanales" -> "jugo artesanale"... solo sirve para COMPARAR nombres, nunca se muestra. */
export function claveProducto(nombre) {
  return plano(nombre).split(' ').filter(p => p && !ARTICULOS.has(p)).map(singular).join(' ');
}

/**
 * @param {{ producto?: string, componentes?: Array<{descripcion, monto}>, costo_total?: string, rinde?: string }} args
 * @returns {{ ok: true, producto, clave, items: object[], total: number, rinde: number|null, costoUnidad: number } | { ok: false, mensaje: string }}
 */
export function armarFichaCosto(args) {
  const producto = limpiar(args?.producto, 60);
  const ejemplo = 'Dime así: "El jugo cuesta: frutas 8, azúcar 2, envases 5".';
  if (!producto) return { ok: false, mensaje: `¿De qué producto es el costo? ${ejemplo}` };
  let lista = Array.isArray(args?.componentes) ? args.componentes.filter(c => c && (c.descripcion || c.monto)) : [];
  const hayTotal = args?.costo_total !== null && args?.costo_total !== undefined && String(args.costo_total).trim() !== '';
  if (lista.length === 0 && hayTotal) lista = [{ descripcion: 'Costo total', monto: args.costo_total }];
  if (lista.length === 0) return { ok: false, mensaje: `¿Cuánto cuesta ${producto}? ${ejemplo}` };
  if (lista.length > MAX_COMPONENTES) return { ok: false, mensaje: `Son muchos componentes (máximo ${MAX_COMPONENTES}). Júntalos en menos líneas.` };
  const items = [];
  for (const c of lista) {
    const descripcion = limpiar(c.descripcion, 60) || 'Otros';
    const monto = parsearMonto(c.monto);
    if (monto === null) return { ok: false, mensaje: `No entendí el monto de "${descripcion}". Dímelo como número, por ejemplo "8".` };
    if (monto > 10000000) return { ok: false, mensaje: `El monto de "${descripcion}" me parece demasiado grande (${formatoMonto(monto)}). Revísalo.` };
    items.push({ descripcion, monto });
  }
  const total = redondear2(items.reduce((s, i) => s + i.monto, 0));
  let rinde = null;
  const hayRinde = args?.rinde !== null && args?.rinde !== undefined && String(args.rinde).trim() !== '';
  if (hayRinde) {
    rinde = parsearMonto(args.rinde);
    if (rinde === null || rinde > 100000) return { ok: false, mensaje: `No entendí cuántas unidades rinde. Dímelo como número, por ejemplo "rinde 10".` };
  }
  const costoUnidad = rinde ? redondear2(total / rinde) : total;
  return { ok: true, producto, clave: claveProducto(producto), items, total, rinde, costoUnidad };
}

const textoRinde = d => (d.rinde ? ` (rinde ${d.rinde} → costo por unidad: ${formatoMonto(d.costoUnidad)})` : '');

export function textoVistaPreviaCosto(d, anterior = null) {
  const l = [`Voy a guardar el costo de "${d.producto}":`, ''];
  for (const i of d.items) l.push(`• ${i.descripcion} — ${formatoMonto(i.monto)}`);
  l.push('', `Costo total: ${formatoMonto(d.total)}${textoRinde(d)}`);
  if (anterior) {
    l.push('', `Ojo: ya tienes un costo de "${anterior.producto}" por ${formatoMonto(Number(anterior.costo_unidad))} por unidad. Este lo reemplaza; el anterior queda en el historial.`);
  }
  l.push('', '¿Lo guardo? Responde "sí" o "no".');
  return l.join('\n');
}

export function textoDetalleCosto(f) {
  let items = [];
  try { items = typeof f.componentes === 'string' ? JSON.parse(f.componentes) : f.componentes || []; } catch { items = []; }
  const l = [`💲 Costo de ${f.producto}:`];
  for (const i of items) l.push(`• ${i.descripcion} — ${formatoMonto(Number(i.monto))}`);
  l.push(`Total: ${formatoMonto(Number(f.total))}${f.rinde ? ` (rinde ${f.rinde} → ${formatoMonto(Number(f.costo_unidad))} por unidad)` : ''}`);
  return l.join('\n');
}

export function textoListaCostos(fichas) {
  if (!fichas || fichas.length === 0) return 'Todavía no tienes costos de productos guardados. Dime, por ejemplo: "El jugo cuesta: frutas 8, azúcar 2, envases 5".';
  const l = ['💲 Costos de tus productos:'];
  for (const f of fichas.slice(0, 30)) l.push(`• ${f.producto} — ${formatoMonto(Number(f.costo_unidad))} por unidad${f.rinde ? ` (total ${formatoMonto(Number(f.total))}, rinde ${f.rinde})` : ''}`);
  if (fichas.length > 30) l.push(`…y ${fichas.length - 30} más.`);
  l.push('', 'Para ver el desglose: "¿cuánto me cuesta el jugo?".');
  return l.join('\n');
}

export function textoSinCosto(producto) {
  return `No tengo un costo guardado de "${producto}". Para guardarlo dime, por ejemplo: "${producto} cuesta: ingredientes 8, envase 2".`;
}

// ── Detección en código (0 tokens) ────────────────────────────────────────────────────────────────
function limpiarProductoDicho(t) {
  return t.replace(/\b(?:por favor|porfa|hoy|ahora|gracias)\b/g, ' ').replace(/^(?:producir|hacer|elaborar|preparar|comprar)\s+/, '')
    .replace(/^(?:el|la|los|las|un|una)\s+/, '').replace(/\s+/g, ' ').trim();
}

/**
 * "¿Cuánto me cuesta el jugo?", "costo del jugo", "mis costos", "lista de costos".
 * @returns {{ tipo: 'lista' } | { tipo: 'producto', producto: string } | null}
 */
export function detectarConsultaCostos(texto) {
  const t = plano(texto);
  if (!t || t.length > 80 || /\d/.test(t)) return null;
  if (/\b(ganancia|ganancias|gane|gano|margen|utilidad)\b/.test(t)) return null;
  if (/\b(excel|pdf|cuadro|factura|cotizacion|proforma|imagen|foto)\b/.test(t)) return null;
  if (/^(?:(?:dame|dime|muestrame|ver|quiero ver|cuales son|que son|enviame|pasame)\s+)?(?:(?:mis|los|las|la)\s+)?(?:lista de\s+)?(?:costos?|fichas? de costos?)(?:\s+de\s+(?:mis\s+)?productos)?$/.test(t)
    || /^que costos tengo$/.test(t)) return { tipo: 'lista' };
  const m = t.match(/\b(?:cuanto|cual)\s+(?:me\s+)?(?:cuesta|cuestan|sale|es\s+el\s+costo\s+(?:de|del|de la|de los|de las))\s+(.+)$/)
    || t.match(/\b(?:costo|costos|ficha de costo)\s+(?:de|del|de la|de los|de las)\s+(.+)$/);
  if (!m) return null;
  const producto = limpiarProductoDicho(m[1]);
  return producto && producto.split(' ').length <= 5 ? { tipo: 'producto', producto } : null;
}

/** "Anula el costo del jugo", "borra el costo de las empanadas". @returns {{ producto: string } | null} */
export function detectarAnularCosto(texto) {
  const original = String(texto ?? '');
  if (/\?/.test(original)) return null;
  const t = plano(original);
  if (!t || t.length > 80) return null;
  if (/\bno\s+(?:\w+\s+)?(?:an+ul|borr|elimin|quit)/.test(t)) return null;
  const m = t.match(/\b(?:an+ul\w*|elimin\w*|borr\w*|quit\w*|deshaz\w*)\s+(?:el\s+|la\s+)?(?:costo|costos|ficha de costo)\s+(?:de|del|de la|de los|de las)\s+(.+)$/);
  if (!m) return null;
  const producto = limpiarProductoDicho(m[1]);
  return producto && producto.split(' ').length <= 5 ? { producto } : null;
}

/** ¿"El jugo me cuesta 17" / "El pastel cuesta: harina 5, huevos 3"? Un registro directo de costo. */
export function esRegistroCostoDirecto(texto) {
  const t = plano(texto);
  if (!t || t.length > 200 || !/\d/.test(t)) return false;
  if (/\?/.test(String(texto ?? '')) || /^(?:cuanto|cual|que|como|donde|quien)\b/.test(t)) return false;
  return /\b(?:cuesta|cuestan|costo|costos)\b/.test(t);
}

/**
 * "¿Cuánto gané este mes?", "ganancia de la semana". El "¿cómo va mi negocio?" (reporte general) es otra cosa.
 * @returns {{ periodo: object } | null}
 */
export function detectarConsultaGanancia(texto, ahora = new Date()) {
  const t = plano(texto);
  if (!t || t.length > 80 || /\d/.test(t)) return null;
  if (!/\b(gane|gano|ganamos|ganancia|ganancias|margen|utilidad)\b/.test(t)) return null;
  if (/\b(negocio|excel|pdf|cuadro|anul\w*|elimin\w*|borr\w*)\b/.test(t)) return null;
  const pregunta = /\b(cuanto|cuanta|dime|dame|muestrame|ver|mi|mis|la|las|resumen|cual|como)\b/.test(t) || /\?/.test(String(texto ?? '')) || /^(ganancia|ganancias)\b/.test(t);
  if (!pregunta) return null;
  return { periodo: periodoDesdeTexto(t, ahora) };
}

// ── Ganancia estimada ─────────────────────────────────────────────────────────────────────────────
/**
 * ¿Qué ficha corresponde a lo vendido? Igual (sin plurales ni tildes) o uno contenido en el otro
 * ("jugo" ↔ "jugo artesanal"). Si hay duda (varias fichas encajan), no se adivina: devuelve null.
 */
export function emparejarCosto(descripcion, fichas) {
  const clave = claveProducto(descripcion);
  if (!clave) return null;
  const tokens = new Set(clave.split(' '));
  const exactas = (fichas || []).filter(f => f.clave === clave);
  if (exactas.length === 1) return exactas[0];
  if (exactas.length > 1) return null;
  const parecidas = (fichas || []).filter(f => {
    const a = (f.clave || '').split(' ').filter(Boolean);
    if (a.length === 0) return false;
    const b = [...tokens];
    return a.every(x => tokens.has(x)) || b.every(x => a.includes(x));
  });
  return parecidas.length === 1 ? parecidas[0] : null;
}

/**
 * @param {{ ventas: Array<{descripcion, cantidad, total, estado?, a_credito?}>, fichas: Array<{producto, clave, costo_unidad}>, periodo: {etiqueta} }} d
 */
export function calcularGanancia(d) {
  const ventas = d.ventas || [];
  const l = [`💰 Ganancia estimada de ${d.periodo.etiqueta}:`];
  if (ventas.length === 0) return [...l, 'No hay ventas registradas en ese período.'].join('\n');
  const porProducto = new Map();
  const sinCosto = new Map();
  for (const v of ventas) {
    const f = emparejarCosto(v.descripcion, d.fichas);
    const total = Number(v.total || 0);
    if (!f) { const k = limpiar(v.descripcion, 40).toLowerCase(); sinCosto.set(k, redondear2((sinCosto.get(k) || 0) + total)); continue; }
    const costo = redondear2(Number(v.cantidad || 0) * Number(f.costo_unidad));
    const g = porProducto.get(f.producto) || { producto: f.producto, unidades: 0, ventas: 0, costo: 0 };
    g.unidades = redondear2(g.unidades + Number(v.cantidad || 0));
    g.ventas = redondear2(g.ventas + total);
    g.costo = redondear2(g.costo + costo);
    porProducto.set(f.producto, g);
  }
  const grupos = [...porProducto.values()].sort((a, b) => b.ventas - a.ventas);
  if (grupos.length === 0) {
    l.push('Ninguna venta de ese período tiene un costo guardado, así que no puedo calcular la ganancia.');
  } else {
    const vendido = redondear2(grupos.reduce((s, g) => s + g.ventas, 0));
    const costo = redondear2(grupos.reduce((s, g) => s + g.costo, 0));
    const ganancia = redondear2(vendido - costo);
    l.push(`Vendido (con costo registrado): ${formatoMonto(vendido)}`, `Costo de esos productos: ${formatoMonto(costo)}`,
      `Ganancia estimada: ${formatoMonto(ganancia)}${vendido > 0 ? ` (${Math.round((ganancia / vendido) * 100)}% de lo vendido)` : ''}`, '', 'Por producto:');
    for (const g of grupos.slice(0, 8)) l.push(`• ${g.producto} — vendido ${formatoMonto(g.ventas)}, costo ${formatoMonto(g.costo)}, ganancia ${formatoMonto(redondear2(g.ventas - g.costo))}`);
    if (grupos.length > 8) l.push(`…y ${grupos.length - 8} productos más (los totales los incluyen).`);
  }
  if (sinCosto.size > 0) {
    const items = [...sinCosto.entries()].slice(0, 8).map(([k, v]) => `${k} (${formatoMonto(v)})`);
    l.push('', `Sin costo guardado (no cuentan): ${items.join(', ')}${sinCosto.size > 8 ? ', …' : ''}.`);
  }
  l.push('', 'Es la ganancia del producto (ventas menos su costo); no descuenta los gastos del negocio.');
  if (ventas.some(v => Number(v.a_credito) === 1 && v.estado === 'pendiente')) l.push('Incluye ventas a crédito que aún no se cobran completas.');
  return l.join('\n');
}