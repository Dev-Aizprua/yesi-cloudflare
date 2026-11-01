// functions/lib/chatWeb.js
// Chat de "Mi oficina" (web). Aparte del webhook de WhatsApp: si algo falla aquí, WhatsApp no se entera.
// Reutiliza los detectores y respondedores del bot (una sola verdad por cifra); no escribe nada en la base.

import { detectarPedidoReporte, detectarSeguimientoReporte, periodoDelMensajeDeReporte } from './reportes.js';
import { detectarRegistroInventario, detectarConsultaInventario, detectarAnularInventario, detectarEliminarProducto } from './inventario.js';
import { detectarConsultaCostos, detectarAnularCosto, detectarConsultaGanancia, esRegistroCostoDirecto } from './costos.js';
import { detectarAgradecimiento, respuestaAgradecimiento } from './atajoArchivos.js';
import { detectarAyuda, textoAyuda } from './ayuda.js';
import { responderCalculo } from './calculadora.js';
import { detectarPedidoOficina } from './accesoWeb.js';
import { detectarAnularRegistro, detectarConsultaVentasGastos, armarResumenVentasGastos, esRegistroDirecto, detectarAnularCobroVenta } from './ventasGastos.js';
import { fechaIsoPanama, fechaLegible, esSiNoPuro, detectarConsultaDeudas, detectarAnularAbono } from './pagos.js';
import { armarReporteDeudasNegocio, armarResumenVentasGastosNegocio, fetchGroq, normalizarClave, obtenerCuadros, resolverAtajoArchivo, responderConsultaCostos, responderConsultaInventario, responderGanancia, responderReporte } from '../api/whatsapp.js';

// ── CHAT DE LA OFICINA WEB (functions/api/web/chat.js): SOLO CONSULTAS, en código, 0 tokens de Groq ──
// Usa los MISMOS detectores y respondedores que el webhook de arriba (una sola verdad: lo que dice WhatsApp y lo que dice la
// web coinciden). No escribe nada: si el mensaje es registrar, anular o cambiar datos, responde que eso se hace por WhatsApp.
// @returns {{ texto: string, atajo: string, ir?: string, archivos?: Array<{id:number, formato:'xlsx'|'pdf', etiqueta:string}> }}
const TEXTO_ESCRITURA_WEB = 'Eso es registrar o cambiar datos, y por ahora se hace por WhatsApp ✍️ Aquí en la web puedo responder consultas: "quién me debe", "cuánto vendí hoy", "cómo va mi negocio este mes", "mi inventario", "cuánto gané", o pedirte el Excel o PDF de un cuadro.';
const TEXTO_SIN_ENTENDER_WEB = 'No estoy seguro de qué me pides 🤔 Aquí en la web puedo responder consultas, por ejemplo: "quién me debe", "cuánto vendí hoy", "cómo va mi negocio este mes", "mi inventario", "cuánto gané", o "pásame el Excel de Préstamos". Para registrar ventas, gastos, cobros o cartas, díselo a tu asistente por WhatsApp.';
const PALABRAS_VG_PURAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'mi', 'mis', 'me', 'cuanto', 'cuantos', 'cuantas', 'vendi', 'vendido', 'vendimos', 'venta', 'ventas', 'gaste', 'gastado', 'gastamos', 'gasto', 'gastos', 'hoy', 'ayer', 'este', 'esta', 'mes', 'semana', 'ano', 'pasado', 'pasada', 'anterior', 'dime', 'dame', 'muestrame', 'ver', 'resumen', 'total', 'totales', 'como', 'fue', 'va', 'he', 'hemos', 'llevo', 'y', 'en', 'lo', 'que', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre']);
const sinCalificativosVG = (t) => normalizarClave(t).split('_').filter(Boolean).every(w => PALABRAS_VG_PURAS.has(w));
export async function responderConsultaWeb(env, negocio, texto, ultimoAsistente = '') {
  const t = String(texto ?? '').trim();
  if (!t) return { texto: TEXTO_SIN_ENTENDER_WEB, atajo: 'vacio' };
  const solo = (texto2, atajo, ir) => ({ texto: texto2, atajo, ...(ir ? { ir } : {}) });

  if (esSiNoPuro(t)) return solo('No tengo nada pendiente por confirmar. Dime qué necesitas y lo hago.', 'sin_pendiente');
  if (detectarAgradecimiento(t)) return solo(respuestaAgradecimiento(), 'agradecimiento');
  if (detectarPedidoOficina(t)) return solo('Ya estás en Mi oficina 😊 Aquí puedes consultar tus cifras, pagos, cuadros, inventario, informes y documentos.', 'oficina_web');
  const pedidoAyuda = detectarAyuda(t);
  if (pedidoAyuda) return solo(textoAyuda(pedidoAyuda.tema, pedidoAyuda.desconocido), 'ayuda');
  const calculo = responderCalculo(t);
  if (calculo) return solo(calculo.texto, 'calculadora');

  // Mismo orden que el webhook (3.8 → 3.12). Lo que escribe o anula se rechaza antes de llegar a su respondedor.
  const consultaDeudas = detectarConsultaDeudas(t);
  if (consultaDeudas) {
    const r = await armarReporteDeudasNegocio(env, negocio, consultaDeudas);
    if (r) return solo(r, 'deudas', 'Pagos');
  }
  if (detectarAnularCobroVenta(t) || detectarAnularAbono(t) || detectarAnularRegistro(t)) return solo(TEXTO_ESCRITURA_WEB, 'solo_whatsapp');

  // Solo si la pregunta es "pura" (sin cliente ni producto): "¿cuánto le vendí a Ana en octubre?" NO se responde con el total de
  // todas las ventas; esa pregunta con filtro la interpreta Groq y la calcula el código con el filtro aplicado.
  const consultaVG = detectarConsultaVentasGastos(t);
  if (consultaVG && sinCalificativosVG(t)) {
    const r = await armarResumenVentasGastosNegocio(env, negocio, consultaVG);
    if (r) return solo(r, 'ventas_gastos', 'Informes');
  }

  {
    const pedidoRep = detectarPedidoReporte(t);
    if (pedidoRep && pedidoRep.error) return solo(pedidoRep.error, 'reporte_error');
    if (pedidoRep) {
      const r = await responderReporte(env, negocio, pedidoRep);
      return solo(pedidoRep.pdf ? `${r.texto}\n\nEl PDF del informe lo puedes pedir por WhatsApp. Aquí lo ves con gráficas en Informes.` : r.texto, 'reporte', 'Informes');
    }
    const seg = detectarSeguimientoReporte(t);
    if (seg) {
      const per = periodoDelMensajeDeReporte(ultimoAsistente);
      if (per) {
        const r = await responderReporte(env, negocio, { periodo: per, comparar: !!seg.comparar || /\nComparado con /.test(String(ultimoAsistente)) });
        return solo(seg.pdf ? 'El PDF del informe lo puedes pedir por WhatsApp ("mándamelo en PDF"). Aquí lo ves con gráficas en Informes.' : r.texto, 'reporte_seguimiento', 'Informes');
      }
    }
  }

  {
    const anularInv = detectarAnularInventario(t);
    const regInv = anularInv ? null : detectarRegistroInventario(t);
    const elimProd = anularInv || regInv ? null : detectarEliminarProducto(t);
    if (anularInv || regInv || elimProd) return solo(TEXTO_ESCRITURA_WEB, 'solo_whatsapp');
    const consInv = detectarConsultaInventario(t);
    if (consInv) {
      const r = await responderConsultaInventario(env, negocio, consInv);
      if (r) return solo(r, 'consulta_inventario', 'Inventario');
    }
  }

  {
    if (detectarAnularCosto(t)) return solo(TEXTO_ESCRITURA_WEB, 'solo_whatsapp');
    const consultaCostos = detectarConsultaCostos(t);
    if (consultaCostos) {
      const r = await responderConsultaCostos(env, negocio, consultaCostos);
      if (r) return solo(r, 'costos');
    }
    const consultaGanancia = consultaCostos ? null : detectarConsultaGanancia(t);
    if (consultaGanancia) return solo(await responderGanancia(env, negocio, consultaGanancia), 'ganancia', 'Informes');
  }

  // "Pásame el Excel/PDF de X": en la web se descarga con un botón (los mismos archivos del bot).
  const atajoArchivo = await resolverAtajoArchivo(env, negocio, t);
  if (atajoArchivo) {
    const cuadros = await obtenerCuadros(env, negocio.id);
    const c = cuadros.find(x => x.nombre_cuadro === atajoArchivo.args.nombre_cuadro);
    let tipo = null;
    try { tipo = JSON.parse(c?.estructura || '{}').tipo || null; } catch { tipo = null; }
    if (c && tipo !== 'secciones') {
      const formato = atajoArchivo.nombre === 'enviar_pdf' ? 'pdf' : 'xlsx';
      return { texto: `Aquí tienes "${c.nombre_cuadro}" ${formato === 'pdf' ? 'en PDF' : 'en Excel'} 👇`, atajo: 'archivo', archivos: [{ id: c.id, formato, etiqueta: `Descargar ${formato === 'pdf' ? 'PDF' : 'Excel'}` }] };
    }
    if (c) return solo('Ese reporte se descarga por ahora desde WhatsApp. Pídeselo a tu asistente.', 'archivo_no_web');
  }

  if (esRegistroDirecto(t) || esRegistroCostoDirecto(t)) return solo(TEXTO_ESCRITURA_WEB, 'solo_whatsapp');
  // El código no entendió la pregunta: Groq solo la interpreta (elige una consulta de una lista cerrada, de solo lectura).
  const deGroq = await consultaWebConGroq(env, negocio, t);
  if (deGroq) return deGroq;
  return solo(TEXTO_SIN_ENTENDER_WEB, 'sin_entender');
}

// ── Groq en el chat web (SOLO interpreta; el código consulta y redacta, Groq nunca escribe una cifra) ──
// Herramientas de solo lectura. Si Groq no llama ninguna, o llama una que no existe, o manda argumentos raros: "sin entender".
// Interruptor: la variable WEB_CHAT_GROQ = "off" lo apaga sin tocar el código.
const HERRAMIENTAS_WEB = [
  { type: 'function', function: { name: 'ventas_gastos', description: 'Lista y suma ventas y/o gastos de un rango de fechas, con filtro opcional por cliente (solo ventas) o por producto/concepto.', parameters: { type: 'object', properties: {
    que: { type: 'string', enum: ['ventas', 'gastos', 'ambos'] },
    desde: { type: 'string', description: 'Fecha inicial AAAA-MM-DD' }, hasta: { type: 'string', description: 'Fecha final AAAA-MM-DD' },
    cliente: { type: 'string', description: 'Nombre del cliente (solo para ventas)' }, texto: { type: 'string', description: 'Producto o concepto, por ejemplo "hielo" o "jugos"' } }, required: ['que', 'desde', 'hasta'] } } },
  { type: 'function', function: { name: 'deuda_cliente', description: 'Cuánto debe un cliente concreto (préstamos, facturas y ventas a crédito).', parameters: { type: 'object', properties: { cliente: { type: 'string' } }, required: ['cliente'] } } },
  { type: 'function', function: { name: 'stock_producto', description: 'Cuánto hay en inventario de un producto.', parameters: { type: 'object', properties: { producto: { type: 'string' } }, required: ['producto'] } } },
  { type: 'function', function: { name: 'costo_producto', description: 'Cuánto cuesta producir o comprar un producto (su costo guardado).', parameters: { type: 'object', properties: { producto: { type: 'string' } }, required: ['producto'] } } },
  { type: 'function', function: { name: 'reporte_periodo', description: 'Reporte general del negocio (ventas, gastos, cobrado, por cobrar, ganancia, más vendidos) de un rango de fechas, opcionalmente comparado con el período anterior.', parameters: { type: 'object', properties: { desde: { type: 'string' }, hasta: { type: 'string' }, comparar: { type: 'boolean' } }, required: ['desde', 'hasta'] } } },
  { type: 'function', function: { name: 'ganancia_periodo', description: 'Ganancia estimada (ventas menos costo de los productos) de un rango de fechas.', parameters: { type: 'object', properties: { desde: { type: 'string' }, hasta: { type: 'string' } }, required: ['desde', 'hasta'] } } },
  { type: 'function', function: { name: 'es_una_accion', description: 'Úsala cuando el mensaje pide REGISTRAR, ANULAR, BORRAR, CAMBIAR, COBRAR, PAGAR o CREAR algo (una venta, un gasto, un cobro, una carta, un producto...). No es una consulta.', parameters: { type: 'object', properties: {} } } },
];
const ISO_WEB = /^\d{4}-\d{2}-\d{2}$/;
function rangoWeb(desde, hasta, hoy) {
  const ok = s => ISO_WEB.test(String(s)) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
  if (!ok(desde) || !ok(hasta) || desde > hasta || desde > hoy) return null;
  const h = hasta > hoy ? hoy : hasta;
  if ((Date.parse(h + 'T00:00:00Z') - Date.parse(desde + 'T00:00:00Z')) / 86400000 > 366) return null;
  return { desde, hasta: h, etiqueta: desde === h ? fechaLegible(desde) : `${fechaLegible(desde)} al ${fechaLegible(h)}` };
}
const textoCorto = (v, max = 60) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
const rad = s => normalizarClave(String(s ?? '')).split('_').filter(Boolean).map(w => (w.length > 3 ? w.replace(/(es|s)$/, '') : w));
const coincideTexto = (campo, consulta) => { const c = normalizarClave(String(campo ?? '')); return rad(consulta).every(w => c.includes(w)); };

async function consultaWebConGroq(env, negocio, texto) {
  if (!env.GROQ_API_KEY || String(env.WEB_CHAT_GROQ || '').toLowerCase() === 'off') return null;
  const hoy = fechaIsoPanama();
  const sistema = `Eres el intérprete de preguntas del chat de "Mi oficina", la oficina web de un negocio. Hoy es ${hoy} (zona Panamá). Tu único trabajo es elegir UNA herramienta que consulte los datos del negocio y pasarle los datos que dijo la persona. NUNCA respondas con cifras ni con texto propio. Reglas: "este mes" = del día 1 del mes actual a hoy; un mes por nombre = del día 1 al último día de ese mes del año actual (o del pasado si aún no llega); "hoy" = ${hoy}. Si el mensaje pide registrar, anular, borrar, cambiar, cobrar, pagar o crear algo, llama es_una_accion. Si no es una pregunta sobre los datos del negocio (hora, clima, chistes, conocimientos generales), NO llames ninguna herramienta.`;
  let data;
  try {
    const res = await fetchGroq('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'system', content: sistema }, { role: 'user', content: texto }], tools: HERRAMIENTAS_WEB, tool_choice: 'auto' }),
    });
    data = await res.json();
  } catch (e) {
    console.log('[WEB-CHAT] Falló Groq:', e?.message);
    return null;
  }
  if (data?.error) { console.log('[WEB-CHAT] Error de Groq:', data.error.message); return null; }
  const llamada = data?.choices?.[0]?.message?.tool_calls?.[0]?.function;
  if (!llamada) return null;
  let a = {};
  try { a = JSON.parse(llamada.arguments || '{}') || {}; } catch { return null; }
  console.log('[WEB-CHAT] Groq eligió:', llamada.name, JSON.stringify(a).slice(0, 200));
  const solo = (t, atajo, ir) => ({ texto: t, atajo: `groq_${atajo}`, ...(ir ? { ir } : {}) });
  const SIN_FECHAS = 'No pude entender las fechas. Dímelas así: "del 5 al 20 de octubre" o "este mes".';
  try {
    switch (llamada.name) {
      case 'es_una_accion': return solo(TEXTO_ESCRITURA_WEB, 'es_una_accion');
      case 'deuda_cliente': {
        const cliente = textoCorto(a.cliente); if (!cliente) return null;
        return solo(await armarReporteDeudasNegocio(env, negocio, { tipo: 'cliente', cliente }), 'deuda_cliente', 'Pagos');
      }
      case 'stock_producto': {
        const producto = textoCorto(a.producto); if (!producto) return null;
        const r = await responderConsultaInventario(env, negocio, { tipo: 'producto', producto });
        return r ? solo(r, 'stock', 'Inventario') : null;
      }
      case 'costo_producto': {
        const producto = textoCorto(a.producto); if (!producto) return null;
        const r = await responderConsultaCostos(env, negocio, { tipo: 'producto', producto });
        return r ? solo(r, 'costo') : null;
      }
      case 'reporte_periodo': {
        const p = rangoWeb(a.desde, a.hasta, hoy); if (!p) return solo(SIN_FECHAS, 'fechas');
        const r = await responderReporte(env, negocio, { periodo: p, comparar: a.comparar === true });
        return solo(r.texto, 'reporte', 'Informes');
      }
      case 'ganancia_periodo': {
        const p = rangoWeb(a.desde, a.hasta, hoy); if (!p) return solo(SIN_FECHAS, 'fechas');
        return solo(await responderGanancia(env, negocio, { periodo: p }), 'ganancia', 'Informes');
      }
      case 'ventas_gastos': {
        const que = ['ventas', 'gastos', 'ambos'].includes(a.que) ? a.que : null;
        const p = rangoWeb(a.desde, a.hasta, hoy);
        if (!que) return null;
        if (!p) return solo(SIN_FECHAS, 'fechas');
        const cliente = textoCorto(a.cliente); const filtro = textoCorto(a.texto);
        const consulta = await armarResumenVentasGastosFiltrado(env, negocio, { que, periodo: p, cliente, filtro });
        return solo(consulta, 'ventas_gastos', 'Informes');
      }
      default: return null; // una herramienta que no existe: se ignora
    }
  } catch (e) {
    console.log('[WEB-CHAT] Error ejecutando la consulta elegida por Groq:', e?.message);
    return null;
  }
}

// Igual que armarResumenVentasGastosNegocio pero con filtro opcional (cliente / producto o concepto). Los totales los suma el código.
async function armarResumenVentasGastosFiltrado(env, negocio, { que, periodo, cliente, filtro }) {
  const db = env.oficina_ia_db;
  let ventas = []; let gastos = [];
  if (que !== 'gastos') {
    ventas = (await db.prepare('SELECT fecha, descripcion, cantidad, precio, total, cliente_nombre, estado, a_credito FROM ventas WHERE negocio_id = ? AND anulado = 0 AND fecha >= ? AND fecha <= ? ORDER BY fecha DESC, id DESC LIMIT 5000').bind(negocio.id, periodo.desde, periodo.hasta).all()).results;
    if (cliente) ventas = ventas.filter(v => coincideTexto(v.cliente_nombre, cliente));
    if (filtro) ventas = ventas.filter(v => coincideTexto(v.descripcion, filtro));
  }
  if (que !== 'ventas') {
    gastos = (await db.prepare('SELECT fecha, descripcion, categoria, monto, proveedor FROM gastos WHERE negocio_id = ? AND anulado = 0 AND fecha >= ? AND fecha <= ? ORDER BY fecha DESC, id DESC LIMIT 5000').bind(negocio.id, periodo.desde, periodo.hasta).all()).results;
    if (filtro) gastos = gastos.filter(g => coincideTexto(g.descripcion, filtro) || coincideTexto(g.proveedor, filtro));
  }
  const etiqueta = [periodo.etiqueta, cliente ? `de ${cliente}` : null, filtro ? `"${filtro}"` : null].filter(Boolean).join(' · ');
  return armarResumenVentasGastos({ que, periodo: { ...periodo, etiqueta }, ventas, gastos });
}