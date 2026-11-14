// functions/lib/correccionReporteSecciones.js
// CORREGIR UN REPORTE "POR SECCIONES" ANTES DE GUARDARLO (la foto de una nota con estadísticas y bloques de etiqueta/valor).
// Groq solo EXTRAE qué quiso corregir el dueño (una corrección por mensaje); este archivo decide si es válida y la aplica.
// Principios del proyecto: el código calcula (aquí nada se suma ni se deduce); nada se guarda sin vista previa y "sí";
// si algo no es claro, se PREGUNTA (nunca se adivina). Funciones puras, sin Groq ni base de datos.
//
// Después de cada corrección el reporte se vuelve a validar con validarReporteSecciones: una fórmula solo sobrevive si
// sigue cuadrando con los números nuevos (si ya no cuadra, la fila queda con su valor fijo y se le avisa al dueño).

import { validarReporteSecciones } from './reporteSecciones.js';

const MAX_FILAS_TOTALES = 60;
const MAX_LARGO_ETIQUETA = 80;
const MAX_LARGO_VALOR = 40;
const MAX_LARGO_TITULO = 80;

const sinTildes = x => String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** "10 Plantas Crédito" → "10plantascredito": sin tildes, mayúsculas, espacios ni signos. */
export function normalizarEtiqueta(x) { return sinTildes(x).replace(/[^a-z0-9]+/g, ''); }

/** Lo que se le muestra a Groq para que elija EXACTAMENTE una etiqueta existente. */
export function describirReporteParaCorreccion(datos) {
  return {
    titulo: datos.titulo || '',
    subtitulo: datos.subtitulo || null,
    estadisticas: (datos.estadisticas || []).map(e => ({ etiqueta: e.etiqueta, valor: e.valor })),
    secciones: (datos.secciones || []).map(s => ({ nombre: s.nombre, filas: (s.filas || []).map(f => ({ etiqueta: f.etiqueta, valor: f.valor })) })),
  };
}

function todasLasFilas(datos) {
  const lista = [];
  (datos.estadisticas || []).forEach((e, i) => lista.push({ donde: 'estadistica', i, etiqueta: e.etiqueta, ruta: `${e.etiqueta}` }));
  (datos.secciones || []).forEach((s, i) => (s.filas || []).forEach((f, j) => lista.push({ donde: 'seccion', i, j, etiqueta: f.etiqueta, ruta: `${s.nombre} › ${f.etiqueta}` })));
  return lista;
}

/** Busca la fila que el dueño nombró: igual (sin tildes ni signos) o, si es la única que lo contiene, esa. */
export function resolverFila(datos, texto) {
  const buscado = normalizarEtiqueta(texto);
  if (!buscado) return { tipo: 'ninguna' };
  const filas = todasLasFilas(datos);
  const iguales = filas.filter(f => normalizarEtiqueta(f.etiqueta) === buscado);
  if (iguales.length === 1) return { tipo: 'ok', fila: iguales[0] };
  if (iguales.length > 1) return { tipo: 'ambigua', candidatos: iguales.map(f => f.ruta) };
  if (buscado.length < 3) return { tipo: 'ninguna' };
  const parecidas = filas.filter(f => { const n = normalizarEtiqueta(f.etiqueta); return n.includes(buscado) || buscado.includes(n); });
  if (parecidas.length === 1) return { tipo: 'ok', fila: parecidas[0] };
  if (parecidas.length > 1) return { tipo: 'ambigua', candidatos: parecidas.map(f => f.ruta) };
  return { tipo: 'ninguna' };
}

function resolverSeccion(datos, texto) {
  const secciones = datos.secciones || [];
  if (secciones.length === 1 && (texto === null || texto === undefined || String(texto).trim() === '')) return { tipo: 'ok', i: 0 };
  const buscado = normalizarEtiqueta(texto);
  if (!buscado) return { tipo: 'falta' };
  const iguales = secciones.map((s, i) => ({ s, i })).filter(({ s }) => normalizarEtiqueta(s.nombre) === buscado);
  if (iguales.length === 1) return { tipo: 'ok', i: iguales[0].i };
  const parecidas = secciones.map((s, i) => ({ s, i })).filter(({ s }) => { const n = normalizarEtiqueta(s.nombre); return n.includes(buscado) || buscado.includes(n); });
  if (parecidas.length === 1) return { tipo: 'ok', i: parecidas[0].i };
  return { tipo: 'falta' };
}

const AYUDA = 'Dime una corrección a la vez, por ejemplo: "el valor de Saldo es 258", "la línea 10 Plantas Crédito es 16 Plantas Crédito", "quita la fila 18 Total", "agrega en Abonos la fila Regalo, valor 3" o "el título es Bazar Atrio Mall".';

function textoValor(v) { return v === null || v === undefined || v === '' ? '(vacío)' : String(v); }
function limpiarTexto(v, max) { return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
/** "B/. 1,158.50" o "$300" → "1158.50" / "300" (así validarReporteSecciones lo toma como número). Si no es un monto, queda tal cual. */
function limpiarValor(v) {
  const t = limpiarTexto(v, MAX_LARGO_VALOR);
  const sinMoneda = t.replace(/^(?:b\/\.?|\$|usd)\s*/i, '').replace(/,(?=\d{3}(?:\D|$))/g, '');
  return /^-?\d+(?:\.\d+)?$/.test(sinMoneda) ? sinMoneda : t;
}

/** Copia en el formato que entiende validarReporteSecciones (la fórmula ya validada, o la que Groq había sugerido, viaja otra vez). */
function aFormatoExtraido(d) {
  return {
    titulo: d.titulo, subtitulo: d.subtitulo,
    estadisticas: (d.estadisticas || []).map(e => ({ etiqueta: e.etiqueta, valor: e.valor })),
    secciones: (d.secciones || []).map(s => ({
      nombre: s.nombre,
      filas: (s.filas || []).map(f => ({ etiqueta: f.etiqueta, valor: f.valor, formula_sugerida: f.formulaOriginal ?? f.formula ?? null })),
    })),
  };
}

function filasConFormula(d) {
  const set = new Set();
  (d.secciones || []).forEach(s => (s.filas || []).forEach(f => { if (f.formula) set.add(`${normalizarEtiqueta(s.nombre)}|${normalizarEtiqueta(f.etiqueta)}`); }));
  return set;
}

/**
 * @param {Object} datos       el reporte pendiente (tipo 'secciones')
 * @param {Object|null} c      lo que extrajo Groq: { objetivo, fila, valor, seccion, etiqueta }
 * @returns {{ ok: true, datos: Object, resumen: string, avisos: string[] } | { ok: false, mensaje: string }}
 */
export function aplicarCorreccionSecciones(datos, c) {
  if (!c || !c.objetivo) return { ok: false, mensaje: `No pude identificar qué quieres corregir. ${AYUDA}` };

  // Copia: nunca se modifica el pendiente original (si algo falla, queda intacto).
  const base = JSON.parse(JSON.stringify(datos));
  const antes = filasConFormula(base);
  let resumen = '';

  if (c.objetivo === 'titulo') {
    const t = limpiarTexto(c.valor, MAX_LARGO_TITULO);
    if (!t) return { ok: false, mensaje: 'No entendí el título nuevo. Escríbelo así: el título es Bazar Atrio Mall.' };
    resumen = `Título: "${base.titulo}" → "${t}"`;
    base.titulo = t;
  } else if (c.objetivo === 'subtitulo') {
    const t = limpiarTexto(c.valor, MAX_LARGO_TITULO);
    resumen = t ? `Subtítulo: "${base.subtitulo || '(ninguno)'}" → "${t}"` : 'Quité el subtítulo';
    base.subtitulo = t || null;
  } else if (c.objetivo === 'agregar_fila') {
    const etiqueta = limpiarTexto(c.etiqueta, MAX_LARGO_ETIQUETA);
    if (!etiqueta) return { ok: false, mensaje: 'No entendí cómo se llama la fila nueva. ' + AYUDA };
    const sec = resolverSeccion(base, c.seccion);
    if (sec.tipo !== 'ok') return { ok: false, mensaje: `¿En cuál sección agrego "${etiqueta}"? Tengo: ${base.secciones.map(s => `"${s.nombre}"`).join(', ')}.` };
    const valor = limpiarValor(c.valor);
    if (!valor) return { ok: false, mensaje: `¿Qué valor lleva "${etiqueta}"? Dímelo así: agrega en ${base.secciones[sec.i].nombre} la fila ${etiqueta}, valor 3.` };
    if (todasLasFilas(base).length >= MAX_FILAS_TOTALES) return { ok: false, mensaje: `Este reporte ya tiene ${MAX_FILAS_TOTALES} filas; no puedo agregar más.` };
    base.secciones[sec.i].filas.push({ etiqueta, valor });
    resumen = `Agregué "${etiqueta}: ${valor}" en "${base.secciones[sec.i].nombre}"`;
  } else if (['valor', 'etiqueta', 'quitar_fila'].includes(c.objetivo)) {
    const r = resolverFila(base, c.fila);
    if (r.tipo === 'ninguna') return { ok: false, mensaje: `No encontré la fila "${limpiarTexto(c.fila, 60)}" en el reporte. Escríbela como aparece en la imagen.` };
    if (r.tipo === 'ambigua') return { ok: false, mensaje: `Hay más de una fila que encaja: ${r.candidatos.map(x => `"${x}"`).join(', ')}. Dime cuál, con el nombre completo.` };
    const f = r.fila;
    const objeto = f.donde === 'estadistica' ? base.estadisticas[f.i] : base.secciones[f.i].filas[f.j];

    if (c.objetivo === 'valor') {
      const v = limpiarValor(c.valor);
      if (!v) return { ok: false, mensaje: `¿Cuál es el valor correcto de "${objeto.etiqueta}"? Dímelo así: el valor de ${objeto.etiqueta} es 258.` };
      resumen = `${objeto.etiqueta}: ${textoValor(objeto.valor)} → ${v}`;
      objeto.valor = v;
    } else if (c.objetivo === 'etiqueta') {
      const nueva = limpiarTexto(c.valor, MAX_LARGO_ETIQUETA);
      if (!nueva) return { ok: false, mensaje: 'No entendí cómo debe llamarse esa línea. Dímelo así: la línea 10 Plantas Crédito es 16 Plantas Crédito.' };
      resumen = `Línea: "${objeto.etiqueta}" → "${nueva}"`;
      objeto.etiqueta = nueva;
    } else {
      if (todasLasFilas(base).length <= 1) return { ok: false, mensaje: 'No puedo quitar la última fila del reporte. Si todo está mal, responde "no" y mándame la foto de nuevo.' };
      resumen = `Quité la fila "${objeto.etiqueta}"`;
      if (f.donde === 'estadistica') base.estadisticas.splice(f.i, 1);
      else base.secciones[f.i].filas.splice(f.j, 1);
    }
  } else {
    return { ok: false, mensaje: `No pude identificar qué quieres corregir. ${AYUDA}` };
  }

  // Se vuelve a validar: las fórmulas solo sobreviven si siguen cuadrando con los números nuevos.
  const validado = validarReporteSecciones(aFormatoExtraido(base));
  const nuevo = { ...base, titulo: validado.titulo, subtitulo: validado.subtitulo, estadisticas: validado.estadisticas, secciones: validado.secciones };
  const despues = filasConFormula(nuevo);
  const avisos = [];
  for (const s of nuevo.secciones) for (const f of s.filas) {
    const clave = `${normalizarEtiqueta(s.nombre)}|${normalizarEtiqueta(f.etiqueta)}`;
    if (antes.has(clave) && !despues.has(clave)) avisos.push(`En "${f.etiqueta}" los números ya no cuadran con su fórmula; queda con el valor ${textoValor(f.valor)}. Si está mal, corrígelo también.`);
  }
  return { ok: true, datos: nuevo, resumen, avisos };
}