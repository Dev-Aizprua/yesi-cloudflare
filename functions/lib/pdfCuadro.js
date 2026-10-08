// functions/lib/pdfCuadro.js
// Genera el PDF de un cuadro (cotización, factura proforma o cualquier tabla).
// Misma firma que excelCuadro.js:
//   generarPdfCuadro(nombreCuadro, columnas, filas, reglas, subtitulo, incluirTotales, extras)
//     -> { bytes, nombreArchivo, mime, camposPendientes }
//
// Principio: los números los calcula el CÓDIGO, nunca un modelo de IA, y este PDF
// usa EXACTAMENTE el mismo cálculo que excelCuadro.js e imagenCuadro.js
// (recalcularCuadro de calculo.js y recalcularPie de tablaExtendida.js), para que
// el PDF, el Excel y la imagen nunca digan cosas distintas. No hay ninguna
// fórmula propia aquí: solo se formatea y se dibuja.
// La única suma es la fila de Totales de un cuadro genérico SIN pie (igual que la
// imagen y el Excel: columnas donde TODAS las filas son número).
//
// Librería: pdf-lib (JavaScript puro, sin fs ni módulos nativos: funciona en Workers).
// Fuentes: Helvetica estándar de PDF (no se descarga nada). Cubre tildes, ñ, "B/." y "—".

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { recalcularCuadro } from './calculo.js';
import { recalcularPie } from './tablaExtendida.js';

// ---------- Estilo ----------
const AZUL = rgb(0x1a / 255, 0x73 / 255, 0xe8 / 255);
const AZUL_CLARO = rgb(0xe8 / 255, 0xf0 / 255, 0xfe / 255);
const GRIS_TEXTO = rgb(0.4, 0.4, 0.4);
const GRIS_LINEA = rgb(0.82, 0.84, 0.88);
const GRIS_FONDO = rgb(0.96, 0.97, 0.98);
const NEGRO = rgb(0.1, 0.1, 0.1);
const AMBAR_FONDO = rgb(1, 0.96, 0.85);
const AMBAR_BORDE = rgb(0.85, 0.6, 0.1);

const PAG_W = 612; // Carta (Letter), usual en Panamá
const PAG_H = 792;
const MARGEN = 40;
const ANCHO = PAG_W - MARGEN * 2;
const AVISO_PROFORMA = 'Documento informativo — no constituye factura fiscal.';

// ---------- Utilidades de texto ----------
const _sets = new WeakMap();
function limpiar(font, texto) {
  let set = _sets.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    _sets.set(font, set);
  }
  const base = String(texto ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2010-\u2012\u2212]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');
  let out = '';
  for (const ch of base) if (set.has(ch.codePointAt(0))) out += ch;
  return out;
}

function ancho(font, texto, size) {
  return font.widthOfTextAtSize(limpiar(font, texto), size);
}

// Parte el texto en líneas que caben en maxW (corta palabras larguísimas).
function envolver(font, texto, size, maxW) {
  const t = limpiar(font, texto).trim();
  if (!t) return [''];
  const lineas = [];
  let actual = '';
  for (const palabra of t.split(/\s+/)) {
    const prueba = actual ? actual + ' ' + palabra : palabra;
    if (font.widthOfTextAtSize(prueba, size) <= maxW) {
      actual = prueba;
      continue;
    }
    if (actual) lineas.push(actual);
    actual = '';
    let resto = palabra;
    while (font.widthOfTextAtSize(resto, size) > maxW && resto.length > 1) {
      let n = resto.length - 1;
      while (n > 1 && font.widthOfTextAtSize(resto.slice(0, n), size) > maxW) n--;
      lineas.push(resto.slice(0, n));
      resto = resto.slice(n);
    }
    actual = resto;
  }
  if (actual) lineas.push(actual);
  return lineas;
}

function sinTildes(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function claveDe(nombre) {
  return sinTildes(nombre).toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().replace(/\s+/g, '_');
}

// ---------- Formato de valores (solo presentación) ----------
function esNumero(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string' && v.trim() !== '') return Number.isFinite(Number(v));
  return false;
}
function dinero(v) {
  if (!esNumero(v)) return v == null ? '' : String(v);
  const [ent, dec] = Math.abs(Number(v)).toFixed(2).split('.');
  const miles = ent.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (Number(v) < 0 ? '-' : '') + miles + '.' + dec;
}
function numeroSimple(v) {
  if (!esNumero(v)) return v == null ? '' : String(v);
  return String(Number(Number(v).toFixed(4)));
}

// ---------- Columnas ----------
// Las filas usan claves internas (item, descripcion, cant, precio_b, total_b, itbms, itbms_b).
// Las columnas traen nombres bonitos. Se enlazan por nombre; si no, por la clave
// genérica del nombre; si no, por posición.
const CLAVES_CONOCIDAS = {
  item: 'item',
  descripcion: 'descripcion',
  cant: 'cant',
  cantidad: 'cant',
  precio_b: 'precio_b',
  total_b: 'total_b',
  itbms: 'itbms',
  itbms_b: 'itbms_b',
};

function resolverColumnas(columnas, filas) {
  const primera = filas[0] || {};
  const clavesFila = Object.keys(primera);
  return columnas.map((nombre, i) => {
    const gen = claveDe(nombre);
    let clave = CLAVES_CONOCIDAS[gen];
    if (!clave || !filas.some((f) => clave in f)) {
      if (filas.some((f) => gen in f)) clave = gen;
      else if (filas.some((f) => nombre in f)) clave = nombre;
      else clave = clavesFila[i] ?? gen;
    }
    const valores = filas.map((f) => f[clave]).filter((v) => v !== null && v !== undefined && v !== '');
    const todosNumeros = valores.length > 0 && valores.every(esNumero);
    // Porcentaje solo si es la columna itbms o el encabezado termina en "%" sin paréntesis
    // ("ITBMS %"). "Interés (10%)" es el nombre de la columna, sus valores son montos.
    const esPct = clave === 'itbms' || /^[^()]*%\s*$/.test(nombre);
    const esDinero = !esPct && (/b\/\./i.test(nombre) || /_b$/.test(clave));
    const esItem = clave === 'item' || String(nombre).trim() === '#';
    const tipo = esItem ? 'item' : todosNumeros || esPct || esDinero ? 'num' : 'texto';
    return { nombre, clave, tipo, esPct, esDinero };
  });
}

function formatearCelda(col, v) {
  if (v === null || v === undefined || v === '') return '';
  if (col.esPct) return esNumero(v) ? numeroSimple(v) + '%' : String(v);
  if (col.esDinero) return dinero(v);
  if (col.tipo === 'num' || col.tipo === 'item') return numeroSimple(v);
  return String(v);
}

function calcularAnchos(cols, celdas, fontN, fontB, size) {
  const PAD = 12;
  const anchos = cols.map((c, i) => {
    if (c.tipo === 'texto') return 0;
    let w = ancho(fontB, c.nombre, size);
    for (const fila of celdas) w = Math.max(w, ancho(fontN, fila[i], size));
    const min = c.tipo === 'item' ? 30 : 46;
    return Math.min(Math.max(w + PAD, min), 100);
  });
  const textos = cols.map((c, i) => (c.tipo === 'texto' ? i : -1)).filter((i) => i >= 0);
  let usado = anchos.reduce((a, b) => a + b, 0);
  if (textos.length) {
    const reparto = Math.max((ANCHO - usado) / textos.length, 60);
    for (const i of textos) anchos[i] = reparto;
    usado = anchos.reduce((a, b) => a + b, 0);
  }
  // Si no cabe, se reduce todo proporcionalmente para ajustarlo al ancho de página.
  const factor = ANCHO / usado;
  return anchos.map((w) => w * factor);
}

// ---------- Encabezado ----------
function analizarEncabezado(nombreCuadro, encabezado) {
  const items = Array.isArray(encabezado) ? encabezado : [];
  const esNumeroDoc = (e) => /(proforma|cotizaci)/i.test(sinTildes(e.etiqueta)) && /(no\.?|n[uú]m)/i.test(sinTildes(e.etiqueta));
  const entradaNumero = items.find(esNumeroDoc) || null;
  const entradaAviso = items.find((e) => /^aviso$/i.test(sinTildes(e.etiqueta).trim())) || null;
  const resto = items.filter((e) => e !== entradaNumero && e !== entradaAviso);

  const etiquetaNum = sinTildes(entradaNumero?.etiqueta || '');
  const esProforma = /proforma/i.test(etiquetaNum) || /proforma/i.test(sinTildes(nombreCuadro)) || !!entradaAviso;
  const esCotizacion = !esProforma && (/cotizaci/i.test(etiquetaNum) || /cotizaci/i.test(sinTildes(nombreCuadro)));

  let titulo = String(nombreCuadro || 'Cuadro');
  if (esProforma) titulo = 'Factura proforma'; // nunca solo "FACTURA"
  else if (esCotizacion) titulo = 'Cotización';

  const vacio = (e) => e.pendiente === true || e.valor === null || e.valor === undefined || String(e.valor).trim() === '';
  const numero = entradaNumero && !vacio(entradaNumero) ? String(entradaNumero.valor) : null;
  const numeroPendiente = !!entradaNumero && !numero;

  let aviso = null;
  if (esProforma) aviso = entradaAviso && !vacio(entradaAviso) ? String(entradaAviso.valor) : AVISO_PROFORMA;

  return { titulo, numero, numeroPendiente, aviso, esProforma, resto, vacio };
}

// ---------- Generador principal ----------
export async function generarPdfCuadro(
  nombreCuadro,
  columnas,
  filas,
  reglas, // reglas_calculo del cuadro: solo se pasan a recalcularCuadro (igual que excelCuadro.js)
  subtitulo,
  incluirTotales = true,
  extras = {}
) {
  columnas = Array.isArray(columnas) ? columnas : [];
  extras = extras || {};
  // Mismo recálculo que excelCuadro.js (valores siempre coherentes con Excel e imagen)
  filas = recalcularCuadro(Array.isArray(filas) ? filas : [], reglas || {});

  const pdf = await PDFDocument.create();
  const fN = await pdf.embedFont(StandardFonts.Helvetica);
  const fB = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fI = await pdf.embedFont(StandardFonts.HelveticaOblique);

  const enc = analizarEncabezado(nombreCuadro, extras.encabezado);
  pdf.setTitle(enc.titulo + (enc.numero ? ' ' + enc.numero : ''));
  pdf.setCreator('Oficina IA');
  pdf.setProducer('Oficina IA');

  let page = pdf.addPage([PAG_W, PAG_H]);
  let y = PAG_H - MARGEN;

  const texto = (t, x, yy, { font = fN, size = 10, color = NEGRO } = {}) => {
    const s = limpiar(font, t);
    if (s) page.drawText(s, { x, y: yy, font, size, color });
  };
  const textoDer = (t, xDer, yy, opts = {}) => {
    const font = opts.font || fN;
    const size = opts.size || 10;
    texto(t, xDer - ancho(font, t, size), yy, opts);
  };

  // --- Título y número ---
  texto(enc.titulo, MARGEN, y - 22, { font: fB, size: 22, color: AZUL });
  if (enc.numero) textoDer('No. ' + enc.numero, PAG_W - MARGEN, y - 22, { font: fB, size: 16 });
  else if (enc.numeroPendiente) textoDer('No. por completar', PAG_W - MARGEN, y - 22, { font: fI, size: 12, color: GRIS_TEXTO });
  y -= 30;
  if (subtitulo) {
    texto(subtitulo, MARGEN, y - 12, { size: 10, color: GRIS_TEXTO });
    y -= 16;
  }
  page.drawLine({ start: { x: MARGEN, y: y - 6 }, end: { x: PAG_W - MARGEN, y: y - 6 }, thickness: 1.5, color: AZUL });
  y -= 18;

  // --- Aviso legal (factura proforma) ---
  if (enc.aviso) {
    const lineas = envolver(fB, enc.aviso, 10.5, ANCHO - 20);
    const h = lineas.length * 14 + 12;
    page.drawRectangle({ x: MARGEN, y: y - h, width: ANCHO, height: h, color: AMBAR_FONDO, borderColor: AMBAR_BORDE, borderWidth: 1 });
    lineas.forEach((l, i) => texto(l, MARGEN + 10, y - 17 - i * 14, { font: fB, size: 10.5, color: rgb(0.45, 0.3, 0) }));
    y -= h + 12;
  }

  // --- Datos del encabezado en dos columnas ---
  const datos = enc.resto;
  if (datos.length) {
    const colW = (ANCHO - 16) / 2;
    for (let i = 0; i < datos.length; i += 2) {
      const par = [datos[i], datos[i + 1]].filter(Boolean);
      const medidas = par.map((e) => {
        const vacio = enc.vacio(e);
        const fuente = vacio ? fI : fN;
        const lineas = envolver(fuente, vacio ? 'por completar' : String(e.valor), 10, colW);
        return { e, vacio, fuente, lineas };
      });
      const h = 11 + Math.max(...medidas.map((m) => m.lineas.length)) * 13 + 6;
      if (y - h < MARGEN + 40) {
        page = pdf.addPage([PAG_W, PAG_H]);
        y = PAG_H - MARGEN;
      }
      medidas.forEach((m, j) => {
        const x = MARGEN + j * (colW + 16);
        texto(String(m.e.etiqueta || '').toUpperCase(), x, y - 9, { font: fB, size: 7.5, color: GRIS_TEXTO });
        m.lineas.forEach((l, k) =>
          texto(l, x, y - 22 - k * 13, { font: m.fuente, size: 10, color: m.vacio ? GRIS_TEXTO : NEGRO })
        );
      });
      y -= h;
    }
    y -= 6;
  }

  // --- Tabla ---
  const SIZE = 9;
  const cols = resolverColumnas(columnas, filas);
  const celdas = filas.map((f) => cols.map((c) => formatearCelda(c, f[c.clave])));

  // Totales de un cuadro genérico sin pie (solo columnas donde TODAS las filas son número)
  const pieCrudo = Array.isArray(extras.pie) ? extras.pie : [];
  const pie = pieCrudo.length ? recalcularPie(pieCrudo, columnas.map(claveDe), filas) : [];
  let filaTotales = null;
  if (!pie.length && incluirTotales && filas.length) {
    filaTotales = cols.map((c, i) => {
      if (i === 0) return 'Total';
      if (c.tipo !== 'num' || c.esPct || !filas.every((f) => esNumero(f[c.clave]))) return '';
      const suma = filas.reduce((a, f) => a + Number(f[c.clave]), 0);
      return c.esDinero ? dinero(suma) : numeroSimple(suma);
    });
  }

  const anchos = calcularAnchos(cols, filaTotales ? [...celdas, filaTotales] : celdas, fN, fB, SIZE);
  const xs = [];
  anchos.reduce((acc, w, i) => ((xs[i] = acc), acc + w), MARGEN);

  const alinea = (c) => (c.tipo === 'texto' ? 'izq' : c.tipo === 'item' ? 'cen' : 'der');
  const dibujarCelda = (c, i, t, yTop, font, color) => {
    const w = anchos[i] - 12;
    const a = alinea(c);
    envolver(font, t, SIZE, w).forEach((l, k) => {
      const tw = ancho(font, l, SIZE);
      const x = a === 'der' ? xs[i] + anchos[i] - 6 - tw : a === 'cen' ? xs[i] + (anchos[i] - tw) / 2 : xs[i] + 6;
      texto(l, x, yTop - 12 - k * 11, { font, size: SIZE, color });
    });
  };
  const alturaFila = (fila, font) =>
    Math.max(...fila.map((t, i) => envolver(font, t, SIZE, anchos[i] - 12).length)) * 11 + 10;

  const dibujarEncabezadoTabla = () => {
    const h = alturaFila(cols.map((c) => c.nombre), fB);
    page.drawRectangle({ x: MARGEN, y: y - h, width: ANCHO, height: h, color: AZUL });
    cols.forEach((c, i) => dibujarCelda(c, i, c.nombre, y, fB, rgb(1, 1, 1)));
    y -= h;
  };

  if (cols.length) {
    dibujarEncabezadoTabla();
    celdas.forEach((fila, r) => {
      const h = alturaFila(fila, fN);
      if (y - h < MARGEN + 50) {
        page = pdf.addPage([PAG_W, PAG_H]);
        y = PAG_H - MARGEN;
        dibujarEncabezadoTabla(); // repite encabezado en cada página
      }
      if (r % 2 === 1) page.drawRectangle({ x: MARGEN, y: y - h, width: ANCHO, height: h, color: GRIS_FONDO });
      fila.forEach((t, i) => dibujarCelda(cols[i], i, t, y, fN, NEGRO));
      page.drawLine({ start: { x: MARGEN, y: y - h }, end: { x: PAG_W - MARGEN, y: y - h }, thickness: 0.5, color: GRIS_LINEA });
      y -= h;
    });

    if (filaTotales) {
      const h = alturaFila(filaTotales, fB);
      if (y - h < MARGEN + 50) {
        page = pdf.addPage([PAG_W, PAG_H]);
        y = PAG_H - MARGEN;
        dibujarEncabezadoTabla();
      }
      page.drawRectangle({ x: MARGEN, y: y - h, width: ANCHO, height: h, color: AZUL_CLARO });
      page.drawLine({ start: { x: MARGEN, y }, end: { x: PAG_W - MARGEN, y }, thickness: 1.5, color: AZUL });
      filaTotales.forEach((t, i) => dibujarCelda(cols[i], i, t, y, fB, NEGRO));
      y -= h;
    }
  }

  // --- Pie (SUBTOTAL / ITBMS / TOTAL): se muestra el "valor" ya calculado ---
  if (pie.length) {
    const PW = 230;
    const filasPie = pie.map((p, idx) => ({
      etiqueta: String(p.etiqueta || ''),
      valor: esNumero(p.valor) ? 'B/. ' + dinero(p.valor) : p.valor == null ? 'por completar' : String(p.valor),
      esTotal: /^total$/i.test(sinTildes(p.etiqueta).trim()) || p.clave === 'total' || (idx === pie.length - 1 && pie.length > 1 && /total/i.test(p.etiqueta)),
    }));
    const hPie = filasPie.length * 22 + 8;
    if (y - hPie < MARGEN + 50) {
      page = pdf.addPage([PAG_W, PAG_H]);
      y = PAG_H - MARGEN;
    }
    y -= 10;
    const x0 = PAG_W - MARGEN - PW;
    filasPie.forEach((p) => {
      if (p.esTotal) {
        page.drawRectangle({ x: x0, y: y - 22, width: PW, height: 22, color: AZUL });
        texto(p.etiqueta.toUpperCase(), x0 + 10, y - 15, { font: fB, size: 11, color: rgb(1, 1, 1) });
        textoDer(p.valor, x0 + PW - 10, y - 15, { font: fB, size: 11, color: rgb(1, 1, 1) });
      } else {
        texto(p.etiqueta, x0 + 10, y - 15, { font: fN, size: 10 });
        textoDer(p.valor, x0 + PW - 10, y - 15, { font: fN, size: 10 });
        page.drawLine({ start: { x: x0, y: y - 22 }, end: { x: x0 + PW, y: y - 22 }, thickness: 0.5, color: GRIS_LINEA });
      }
      y -= 22;
    });
  }

  // --- Pie de página: paginación y (proforma) aviso legal en todas las páginas ---
  const paginas = pdf.getPages();
  paginas.forEach((p, i) => {
    const t = `Página ${i + 1} de ${paginas.length}`;
    const s = limpiar(fN, t);
    p.drawText(s, { x: PAG_W - MARGEN - fN.widthOfTextAtSize(s, 8), y: 22, font: fN, size: 8, color: GRIS_TEXTO });
    if (enc.aviso) {
      p.drawText(limpiar(fB, enc.aviso), { x: MARGEN, y: 22, font: fB, size: 8, color: GRIS_TEXTO });
    }
  });

  const bytes = await pdf.save();
  // Misma convención que excelCuadro.js: "Cotización 004 - Juan" → cotizacion_004_juan.pdf
  const base = claveDe(nombreCuadro).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const nombreArchivo = (base || 'cuadro') + '.pdf';
  // Igual que excelCuadro.js: qué campos quedaron vacíos por no saberse (para avisarle al usuario)
  const camposPendientes = enc.resto.filter((e) => enc.vacio(e)).map((e) => String(e.etiqueta));
  if (enc.numeroPendiente) camposPendientes.unshift('Número');
  for (const p of pie) if (p.pendiente || p.valor === null || p.valor === undefined) camposPendientes.push(String(p.etiqueta));

  return { bytes, nombreArchivo, mime: 'application/pdf', camposPendientes };
}