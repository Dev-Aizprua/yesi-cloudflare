// functions/lib/inventario.js
// Inventario básico. Lógica PURA, sin base de datos ni WhatsApp.
// Principios (los mismos de todo el proyecto): todo se detecta y se calcula en código (0 tokens de Groq); el stock
// NUNCA se guarda: se deriva de movimientos que solo se agregan (entrada, ajuste, venta) y se anulan, no se borran.
// Solo llevan inventario los productos que el dueño registra. Las ventas se guardan SIEMPRE: si el stock no alcanza,
// solo se avisa. Nada se guarda sin vista previa y "sí".

import { formatoMonto, redondear2 } from './pagos.js';
import { claveProducto, emparejarCosto } from './costos.js';

const sinTildes = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function formatoCantidad(n) {
  const x = Math.round(Number(n) * 100) / 100;
  return Number.isInteger(x) ? String(x) : String(x);
}

const PALABRAS = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100,
  docena: 12,
};
const NUM = '(\\d+(?:[.,]\\d+)?|[a-z]+)';

/** "30", "2,5", "treinta", "una docena", "media docena" → número ≥ 0, o null. */
export function numeroCantidad(token) {
  const t = sinTildes(token).trim();
  if (/^\d+(?:[.,]\d+)?$/.test(t)) return Number(t.replace(',', '.'));
  if (t === 'media docena') return 6;
  if (t === 'cero') return 0;
  return Object.prototype.hasOwnProperty.call(PALABRAS, t) ? PALABRAS[t] : null;
}

const ARTICULOS = /^(?:el|la|los|las|un|una|unos|unas|mi|mis|unidades de|unidad de|de|del)\s+/;
function limpiarProducto(txt) {
  let p = String(txt ?? '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) p = p.replace(ARTICULOS, '');
  p = p.replace(/\s+(?:al|en el|a mi|en mi)\s+inventario$/i, '').replace(/\s+(?:en|de)\s+(?:inventario|stock)$/i, '').trim();
  return p;
}

// ¿A lo más una letra de diferencia (sobra, falta, cambia o dos juntas al revés)? "ntraron" ↔ "entraron".
function cerca(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let d = 0; const idx = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { d++; idx.push(i); }
    if (d === 1) return true;
    return d === 2 && idx[1] === idx[0] + 1 && a[idx[0]] === b[idx[1]] && a[idx[1]] === b[idx[0]];
  }
  const [c, l] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === c) return true;
  return false;
}
const VERBOS_CONOCIDOS = ['entraron', 'llegaron', 'quedaron', 'recibi', 'produje', 'compre', 'agregue', 'ingrese', 'elabore', 'prepare', 'contabilice', 'tenemos'];
const PREFIJOS = new Set(['me', 'ya', 'hoy', 'ayer']);
// Erratas de dedo en el verbo ("ntraron 30 panes", "entrarom 30 panes", "recibi"): se corrige SOLO el verbo, con una
// letra de tolerancia y palabras de 6 letras o más (para no confundir "tengo", "hay", "agrega"…). Igual hay vista previa.
function corregirVerbo(orig, s) {
  const to = orig.split(' '); const ts = s.split(' ');
  for (let i = 0; i < Math.min(3, ts.length); i++) {
    if (PREFIJOS.has(ts[i])) continue;
    if (ts[i].length >= 6 && !VERBOS_CONOCIDOS.includes(ts[i]) && !/^\d/.test(ts[i])) {
      const v = VERBOS_CONOCIDOS.find(k => cerca(ts[i], k));
      if (v) { to[i] = v; ts[i] = v; }
    } else if (ts[i].length === 7 && ts[i] === 'ntraron') { to[i] = 'entraron'; ts[i] = 'entraron'; }
    break;
  }
  return { orig: to.join(' '), s: ts.join(' ') };
}

// Prepara el texto: sin puntuación final, y la versión sin tildes tiene el MISMO largo para poder recortar el original.
function preparar(texto) {
  const orig = String(texto ?? '').trim().replace(/[.!¡\s]+$/, '');
  return { orig, s: sinTildes(orig) };
}
function recortar(orig, s, grupo) {
  const i = s.indexOf(grupo);
  return i >= 0 && orig.length === s.length ? orig.slice(i, i + grupo.length) : grupo;
}
const PALABRAS_NO_PRODUCTO = /^(?:ganancia|ganancias|venta|ventas|gasto|gastos|deuda|deudas|saldo|dinero|plata|efectivo|clientes?|cuadros?|facturas?|cotizacion|cotizaciones|tiempo|hambre|sueno|razon)\b/;
const CON_PRECIO = /(\$|\bpor\s+\d|\ba\s+\$?\d|\bdolar|\bbalboa|\bcada\s|\bc\/u|\bprecio|\bfiad|\bcredito|\bgast[eo])/;

/**
 * Pedidos de registro de inventario escritos con claridad.
 *  - entrada: "entraron 30 panes", "recibí 20 jugos", "compré 30 panes" (sin precio), "agrega 10 panes al inventario"
 *  - ajuste (conteo real): "me quedan 12 jugos", "tengo 20 jugos en inventario", "quedan 5 panes"
 *  - minimo: "avísame si quedan menos de 5 panes", "el mínimo de jugos es 5"
 * `ambiguo: true` = el verbo también se usa para otras cosas (comprar = gasto; tengo/hay): solo vale si el producto
 * YA está en el inventario o el mensaje dice "inventario". El que llama decide; si no vale, sigue por Groq.
 * @returns {{ accion: 'entrada'|'ajuste', producto: string, cantidad: number, ambiguo: boolean } | { accion: 'minimo', producto: string, minimo: number } | null}
 */
export function detectarRegistroInventario(texto) {
  if (/\?/.test(String(texto ?? ''))) return null;
  const prep = preparar(texto);
  const { orig, s } = corregirVerbo(prep.orig, prep.s);
  if (!s || s.length > 120) return null;
  const dice = /\binventario\b|\bstock\b/.test(s);

  // ajuste explícito ("ajusta el inventario de jugos a 12"): el "a 12" no es un precio
  let m = s.match(new RegExp(`^(?:ajusta|ajustar|actualiza|corrige)\\s+(?:el\\s+)?(?:inventario|stock)\\s+(?:de|del|de la|de los|de las)\\s+(.+?)\\s+(?:a|en|:)\\s*${NUM}$`))
    || s.match(new RegExp(`^(?:inventario|stock)\\s+(?:de|del|de la|de los|de las)\\s+(.+?)\\s*(?:es|son|:|a)\\s*${NUM}$`));
  if (m) {
    const n = numeroCantidad(m[2]);
    const producto = limpiarProducto(recortar(orig, s, m[1]));
    return n !== null && producto && producto.split(' ').length <= 5 ? { accion: 'ajuste', producto, cantidad: n, ambiguo: false } : null;
  }

  if (CON_PRECIO.test(s)) return null;

  // mínimo
  m = s.match(new RegExp(`^(?:avisame|avisa|alertame|avisarme)\\s+(?:si\\s+)?(?:quedan|bajan|baja|hay|tengo|me quedan)\\s+(?:menos de|menos que|bajo de)\\s+${NUM}\\s+(.+)$`));
  if (m) {
    const n = numeroCantidad(m[1]);
    const producto = limpiarProducto(recortar(orig, s, m[2]));
    return n !== null && producto && producto.split(' ').length <= 5 ? { accion: 'minimo', producto, minimo: n } : null;
  }
  m = s.match(new RegExp(`^(?:el\\s+)?(?:stock\\s+)?minimo\\s+(?:de|del|para)\\s+(.+?)\\s+(?:es|son|sera|:|a)?\\s*${NUM}$`));
  if (m) {
    const n = numeroCantidad(m[2]);
    const producto = limpiarProducto(recortar(orig, s, m[1]));
    return n !== null && producto && producto.split(' ').length <= 5 ? { accion: 'minimo', producto, minimo: n } : null;
  }

  // entrada
  m = s.match(new RegExp(`^(?:(?:ya|hoy|ayer)\\s+)?(compre|recibi|llegaron|me llegaron|entraron|me entraron|produje|hice|prepare|elabore|agregue|sume|anota|anade|agrega|suma|ingrese|ingresa|anade al inventario|agrega al inventario)\\s+${NUM}\\s+(.+)$`));
  if (m) {
    const n = numeroCantidad(m[2]);
    let crudo = m[3];
    let cantidad = n;
    if (m[2] === 'media' && /^docena\b/.test(crudo)) { cantidad = 6; crudo = crudo.replace(/^docena\s+(?:de\s+)?/, ''); }
    else if (m[2] === 'una' && /^docena\b/.test(crudo)) { cantidad = 12; crudo = crudo.replace(/^docena\s+(?:de\s+)?/, ''); }
    const producto = limpiarProducto(recortar(orig, s, crudo));
    if (cantidad === null || !(cantidad > 0) || !producto || producto.split(' ').length > 5 || PALABRAS_NO_PRODUCTO.test(sinTildes(producto))) return null;
    // "agrega/anota/suma…" sirven para mil cosas ("agrega una fila"): solo cuentan si el mensaje dice "inventario"
    if (/^(?:agregue|sume|anota|anade|agrega|suma|ingrese|ingresa|anade al inventario|agrega al inventario)$/.test(m[1]) && !dice) return null;
    const ambiguo = /^(?:compre|hice|prepare|elabore)$/.test(m[1]) && !dice;
    return { accion: 'entrada', producto, cantidad, ambiguo };
  }

  // ajuste por conteo
  m = s.match(new RegExp(`^(?:me\\s+)?(quedan|quedaron|quedo|tengo|hay|conte|contabilice|cuento|tenemos)\\s+${NUM}\\s+(.+)$`));
  if (m) {
    const n = numeroCantidad(m[2]);
    const producto = limpiarProducto(recortar(orig, s, m[3]));
    if (n === null || !producto || producto.split(' ').length > 5 || PALABRAS_NO_PRODUCTO.test(sinTildes(producto))) return null;
    const ambiguo = !(dice || /^(?:quedan|quedaron|quedo|conte|contabilice|cuento)$/.test(m[1]));
    return { accion: 'ajuste', producto, cantidad: n, ambiguo };
  }
  return null;
}

/**
 * "mi inventario", "¿cuánto me queda de jugos?", "cuántos panes me quedan", "stock de jugos".
 * @returns {{ tipo: 'lista' } | { tipo: 'producto', producto: string } | null}
 */
export function detectarConsultaInventario(texto) {
  const { orig, s: s0 } = preparar(String(texto ?? '').replace(/[¿?]/g, ''));
  const s = s0.replace(/\s+/g, ' ');
  if (!s || s.length > 80 || /\d/.test(s)) return null;
  if (/\b(excel|pdf|cuadro|factura|cotizacion|proforma|imagen|foto)\b/.test(s)) return null;
  if (/^(?:(?:dame|dime|muestrame|ver|quiero ver|enviame|pasame|revisa)\s+)?(?:(?:mi|el|mis|los|las|la)\s+)?(?:inventario|stock|existencias?)(?:\s+(?:de\s+)?(?:mis\s+)?(?:productos|mercancia))?$/.test(s)
    || /^(?:que|cuanto)\s+(?:tengo\s+)?(?:en\s+)?(?:inventario|stock)(?:\s+tengo)?$/.test(s) || /^cuanto stock tengo$/.test(s)) return { tipo: 'lista' };
  let m = s.match(/^cuant[oa]s?\s+(?:me\s+)?(?:queda|quedan|tengo|hay|stock|inventario)\s+(?:de\s+|del\s+|de la\s+|de los\s+|de las\s+)?(.+)$/)
    || s.match(/^cuantos?\s+(.+?)\s+(?:me\s+)?(?:quedan|tengo|hay|me quedan)$/)
    || s.match(/^(?:stock|inventario|existencias?)\s+(?:de|del|de la|de los|de las)\s+(.+)$/);
  if (!m) return null;
  const producto = limpiarProducto(recortar(orig.replace(/[¿?]/g, ''), s0, m[1]));
  if (!producto || producto.split(' ').length > 4 || PALABRAS_NO_PRODUCTO.test(sinTildes(producto)) || /^(?:dinero|plata)/.test(sinTildes(producto))) return null;
  return { tipo: 'producto', producto };
}

/** "Anula la última entrada de panes", "anula el último movimiento de inventario", "borra el ajuste de jugos". */
export function detectarAnularInventario(texto) {
  if (/\?/.test(String(texto ?? ''))) return null;
  const { orig, s } = preparar(texto);
  if (!s || s.length > 90) return null;
  if (/\bno\s+(?:\w+\s+)?(?:an+ul|borr|elimin|quit|deshaz)/.test(s)) return null;
  const m = s.match(/^(?:an+ul\w*|elimin\w*|borr\w*|quit\w*|deshaz\w*|deshac\w*)\s+(?:por favor\s+)?(?:el\s+|la\s+)?(?:ultim[oa]\s+)?(movimiento|entrada|ajuste|conteo)(?:\s+(?:ultim[oa]))?(?:\s+de\s+inventario)?(?:\s+(?:de|del|de la|de los|de las)\s+(.+))?$/);
  if (!m) return null;
  if (m[2] && /\b(factura|cotizacion|proforma|cuadro|caja|banco|efectivo)\b/.test(m[2])) return null;
  const producto = m[2] ? limpiarProducto(recortar(orig, s, m[2])) : null;
  if (m[2] && (!producto || producto.split(' ').length > 4)) return null;
  return { producto: producto || null, clase: m[1] };
}

/** "Elimina el producto jugo del inventario", "quita los panes del inventario" (siempre dice "del inventario"). */
export function detectarEliminarProducto(texto) {
  if (/\?/.test(String(texto ?? ''))) return null;
  const { orig, s } = preparar(texto);
  if (!s || s.length > 90) return null;
  if (/\bno\s+(?:\w+\s+)?(?:an+ul|borr|elimin|quit|sac)/.test(s)) return null;
  const m = s.match(/^(?:elimin\w*|borr\w*|quit\w*|sac\w*)\s+(?:por favor\s+)?(?:el\s+|la\s+|los\s+|las\s+)?(?:producto\s+|articulo\s+)?(.+?)\s+del\s+inventario$/);
  if (!m) return null;
  if (/^(?:movimientos?|entradas?|ajustes?|conteos?|ultim)/.test(m[1]) || /\b(factura|cotizacion|proforma|cuadro|gasto|venta|cobro|pago|abono)\b/.test(m[1])) return null;
  const producto = limpiarProducto(recortar(orig, s, m[1]));
  if (!producto || producto.split(' ').length > 4 || PALABRAS_NO_PRODUCTO.test(sinTildes(producto))) return null;
  return { producto };
}

export function textoPrevioEliminarProducto(producto, stock) {
  return `Voy a quitar "${producto}" de tu inventario (ahora hay ${formatoCantidad(stock)}).\n\nNo se borra nada: queda su historial y tus ventas anteriores no cambian. Si después vuelves a registrarlo, empieza de cero.\n\n¿Lo quito? Responde "sí" o "no".`;
}

// ── Productos y stock ─────────────────────────────────────────────────────────────────────────────

/** Producto del inventario que corresponde a lo dicho: exacto o contenido (único). null si no hay o hay duda. */
export function emparejarProductoInventario(nombre, productos) {
  return emparejarCosto(nombre, productos);
}
/** Solo el que tiene EXACTAMENTE la misma clave (para decidir si una entrada es de un producto existente). */
export function productoExacto(nombre, productos) {
  const c = claveProducto(nombre);
  return (productos || []).find(p => p.clave === c) || null;
}

/**
 * Arma lo que se va a guardar para un registro de inventario y la vista previa. NO toca la base.
 * @param {object} pedido  de detectarRegistroInventario
 * @param {Array<{id, producto, clave, minimo, stock}>} productos  los del inventario, con su stock actual
 */
export function armarRegistroInventario(pedido, productos) {
  const exacto = productoExacto(pedido.producto, productos);
  const parecido = exacto ? null : emparejarProductoInventario(pedido.producto, productos);
  const clave = claveProducto(pedido.producto);
  if (!clave) return { ok: false, mensaje: 'No entendí de qué producto es. Dime, por ejemplo: "Entraron 30 panes".' };
  const nombre = exacto ? exacto.producto : pedido.producto;
  const stock = exacto ? redondear2(Number(exacto.stock)) : 0;

  if (pedido.accion === 'minimo') {
    if (!exacto) return { ok: false, mensaje: `No tengo "${pedido.producto}" en tu inventario todavía. Primero dime cuántos hay, por ejemplo: "Tengo 20 ${pedido.producto}".` };
    const datos = { tipoPendiente: 'inventario', accion: 'minimo', producto: nombre, clave, minimo: pedido.minimo };
    return { ok: true, datos, texto: textoVistaPreviaInventario(datos, { stock, nuevo: false, parecido }) };
  }
  if (pedido.accion === 'entrada') {
    if (!(pedido.cantidad > 0)) return { ok: false, mensaje: 'La cantidad tiene que ser mayor que cero.' };
    const datos = { tipoPendiente: 'inventario', accion: 'entrada', producto: nombre, clave, cantidad: pedido.cantidad };
    return { ok: true, datos, texto: textoVistaPreviaInventario(datos, { stock, nuevo: !exacto, parecido }) };
  }
  // ajuste: el movimiento se calcula al guardar (objetivo − stock de ese momento); aquí solo se muestra
  const datos = { tipoPendiente: 'inventario', accion: 'ajuste', producto: nombre, clave, objetivo: pedido.cantidad };
  return { ok: true, datos, texto: textoVistaPreviaInventario(datos, { stock, nuevo: !exacto, parecido }) };
}

export function textoVistaPreviaInventario(d, { stock, nuevo, parecido }) {
  const l = [];
  if (d.accion === 'minimo') {
    l.push(`Voy a poner el mínimo de "${d.producto}" en ${formatoCantidad(d.minimo)}.`);
    l.push(`Te aviso cuando una venta lo deje en ${formatoCantidad(d.minimo)} o menos (ahora hay ${formatoCantidad(stock)}).`);
  } else if (d.accion === 'entrada') {
    l.push(`Voy a registrar una entrada de inventario:`, '');
    l.push(`• Producto: ${d.producto}${nuevo ? ' (nuevo en tu inventario)' : ''}`);
    l.push(`• Entran: ${formatoCantidad(d.cantidad)}`);
    l.push(`• Stock: ${formatoCantidad(stock)} → ${formatoCantidad(redondear2(stock + d.cantidad))}`);
  } else {
    const dif = redondear2(d.objetivo - stock);
    l.push(`Voy a ajustar el inventario de "${d.producto}" a lo que contaste:`, '');
    l.push(`• Tengo registrados: ${formatoCantidad(stock)}${nuevo ? ' (producto nuevo en tu inventario)' : ''}`);
    l.push(`• Tú dices que hay: ${formatoCantidad(d.objetivo)}`);
    l.push(dif === 0 ? '• No hay diferencia.' : `• Ajuste: ${dif > 0 ? '+' : ''}${formatoCantidad(dif)}`);
  }
  if (parecido && nuevo) {
    l.push('', `Ojo: ya tienes "${parecido.producto}" en el inventario. Esto se guardaría como un producto aparte. Si es el mismo, di "no" y repítelo con ese nombre.`);
  }
  l.push('', '¿Lo guardo? Responde "sí" o "no".');
  return l.join('\n');
}

const alerta = (p, stock) => stock < -0.0001 || (p.minimo !== null && p.minimo !== undefined && stock <= Number(p.minimo) + 0.0001);

export function textoLineaStock(p) {
  const stock = redondear2(Number(p.stock));
  const min = p.minimo !== null && p.minimo !== undefined ? ` (mín. ${formatoCantidad(Number(p.minimo))})` : '';
  return `• ${p.producto}: ${formatoCantidad(stock)}${min}${alerta(p, stock) ? ' ⚠️' : ''}`;
}

export function textoListaInventario(productos) {
  if (!productos || productos.length === 0) return textoInventarioVacio();
  const l = ['📦 Tu inventario:', ''];
  for (const p of productos) l.push(textoLineaStock(p));
  if (productos.some(p => alerta(p, redondear2(Number(p.stock))))) l.push('', '⚠️ = stock bajo o en negativo (revisa si falta anotar una entrada).');
  return l.join('\n');
}

export function textoInventarioVacio() {
  return 'Todavía no tienes productos en el inventario. Para empezar dime cuántos tienes, por ejemplo: "Tengo 20 jugos" o "Entraron 30 panes". Cada venta de esos productos se descuenta sola.';
}

export function textoDetalleStock(p) {
  const stock = redondear2(Number(p.stock));
  let t = stock < 0
    ? `De "${p.producto}" el sistema marca ${formatoCantidad(stock)}: se vendió más de lo que anotaste. Revisa y anota lo que falte, por ejemplo: "Entraron 20 ${p.producto}", o cuenta y dime "Tengo X ${p.producto}".`
    : `Te quedan ${formatoCantidad(stock)} de ${p.producto}.`;
  if (p.minimo !== null && p.minimo !== undefined) t += ` Mínimo: ${formatoCantidad(Number(p.minimo))}${alerta(p, stock) && stock >= 0 ? ' — ¡ya estás en el mínimo o por debajo! ⚠️' : '.'}`;
  return t;
}

export function textoSinProducto(producto, hayInventario) {
  return hayInventario
    ? `No tengo "${producto}" en tu inventario. Para registrarlo dime cuántos hay, por ejemplo: "Tengo 20 ${producto}".`
    : textoInventarioVacio();
}

/**
 * Descuento de una venta. Agrupa por producto del inventario, calcula el stock que quedaría y arma los avisos.
 * NUNCA bloquea: la venta se guarda igual.
 * @param {Array<{descripcion, cantidad}>} items  artículos de la venta
 * @param {Array<{id, producto, clave, minimo, stock}>} productos
 * @returns {{ movimientos: Array<{itemIndex, productoId, cantidad}>, lineas: string[] }}
 */
export function planDescuentoVenta(items, productos) {
  const movimientos = [];
  const porProducto = new Map();
  (items || []).forEach((it, itemIndex) => {
    const p = emparejarProductoInventario(it.descripcion, productos);
    const cant = Number(it.cantidad);
    if (!p || !(cant > 0)) return;
    movimientos.push({ itemIndex, productoId: p.id, cantidad: cant });
    const a = porProducto.get(p.id) || { p, vendido: 0 };
    a.vendido += cant;
    porProducto.set(p.id, a);
  });
  const lineas = [];
  for (const { p, vendido } of porProducto.values()) {
    const antes = redondear2(Number(p.stock));
    const despues = redondear2(antes - vendido);
    if (despues < -0.0001) {
      lineas.push(`⚠️ ${p.producto}: no alcanzaba el stock (tenías ${formatoCantidad(antes)} y vendiste ${formatoCantidad(vendido)}). Quedó en ${formatoCantidad(despues)}; revisa tu inventario y anota lo que falte.`);
    } else if (p.minimo !== null && p.minimo !== undefined && despues <= Number(p.minimo) + 0.0001) {
      lineas.push(`⚠️ Stock bajo: de ${p.producto} quedan ${formatoCantidad(despues)} (tu mínimo es ${formatoCantidad(Number(p.minimo))}).`);
    } else {
      lineas.push(`📦 ${p.producto}: quedan ${formatoCantidad(despues)}.`);
    }
  }
  return { movimientos, lineas };
}

export function textoPrevioAnularInventario(m, producto, stockActual) {
  const delta = Number(m.cantidad);
  const despues = redondear2(stockActual - delta);
  return [
    `Voy a anular este movimiento de inventario:`, '',
    `• ${m.tipo === 'ajuste' ? 'Ajuste' : 'Entrada'} de "${producto}": ${delta > 0 ? '+' : ''}${formatoCantidad(delta)}`,
    `• Stock: ${formatoCantidad(stockActual)} → ${formatoCantidad(despues)}`, '',
    'No se borra: queda en el historial. ¿Lo anulo? Responde "sí" o "no".',
  ].join('\n');
}