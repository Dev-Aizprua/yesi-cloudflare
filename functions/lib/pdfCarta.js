// functions/lib/pdfCarta.js
// Misma carta que genera motorCartas.js (Word), pero en PDF. No tiene lógica propia de
// contenido: usa renderizarCuerpo y capitalizarInicio del motor, así el Word y el PDF
// siempre dicen exactamente lo mismo. Librería: pdf-lib (JS puro, funciona en Workers),
// la misma que ya usa pdfCuadro.js. Fuente: Helvetica estándar (cubre tildes y ñ).

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { renderizarCuerpo, capitalizarInicio } from './motorCartas.js';

const PAG_W = 612; // Carta (Letter)
const PAG_H = 792;
const MARGEN = 72;
const ANCHO = PAG_W - MARGEN * 2;
const NEGRO = rgb(0.1, 0.1, 0.1);
const GRIS = rgb(0.33, 0.33, 0.33);
const SIZE = 11;
const INTERLINEADO = 16;

const FECHA_LARGA = new Intl.DateTimeFormat('es-PA', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Panama',
});

const _sets = new WeakMap();
function limpiar(font, texto) {
  let set = _sets.get(font);
  if (!set) { set = new Set(font.getCharacterSet()); _sets.set(font, set); }
  const base = String(texto ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ /g, ' ')
    .replace(/[‐-‒−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
  let out = '';
  for (const ch of base) if (set.has(ch.codePointAt(0))) out += ch;
  return out;
}

function envolver(font, texto, size, maxW) {
  const t = limpiar(font, texto).trim();
  if (!t) return [''];
  const lineas = [];
  let actual = '';
  for (const palabra of t.split(/\s+/)) {
    const prueba = actual ? actual + ' ' + palabra : palabra;
    if (font.widthOfTextAtSize(prueba, size) <= maxW) { actual = prueba; continue; }
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

function nombreArchivo(nombrePlantilla) {
  const base = String(nombrePlantilla)
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${base || 'carta'}.pdf`;
}

/**
 * Mismos parámetros que generarDocxCarta(plantilla, campos, configNegocio).
 * @returns {Promise<{ bytes: Uint8Array, nombreArchivo: string, mime: string }>}
 */
export async function generarPdfCarta(plantilla, campos, configNegocio) {
  let membreteNegocio = {};
  try {
    membreteNegocio = configNegocio?.membrete_carta ? JSON.parse(configNegocio.membrete_carta) : {};
  } catch (e) {
    membreteNegocio = {};
  }
  const membrete = campos._sin_encabezado === true ? {} : membreteNegocio;

  const camposParaMostrar = {};
  for (const [id, valor] of Object.entries(campos)) {
    if (id.startsWith('_')) continue;
    camposParaMostrar[id] = capitalizarInicio(valor);
  }

  let firmaNombre = configNegocio?.firma_carta || membreteNegocio.nombre || '';
  let firmaCedula = null;
  if (plantilla.campoFirmaNombre && campos[plantilla.campoFirmaNombre]) {
    firmaNombre = camposParaMostrar[plantilla.campoFirmaNombre];
    if (plantilla.campoFirmaCedula && campos[plantilla.campoFirmaCedula]) {
      firmaCedula = campos[plantilla.campoFirmaCedula];
    }
  }

  const fechaHoy = FECHA_LARGA.format(new Date());
  const ciudad = membrete.direccion || '';
  const cuerpo = renderizarCuerpo(plantilla.cuerpo, camposParaMostrar);

  const pdf = await PDFDocument.create();
  const fN = await pdf.embedFont(StandardFonts.Helvetica);
  const fB = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle(plantilla.nombre);
  pdf.setCreator('Oficina IA');
  pdf.setProducer('Oficina IA');

  let page = pdf.addPage([PAG_W, PAG_H]);
  let y = PAG_H - MARGEN;

  const nuevaPaginaSiHaceFalta = (alto) => {
    if (y - alto < MARGEN) { page = pdf.addPage([PAG_W, PAG_H]); y = PAG_H - MARGEN; }
  };
  const centrado = (t, font, size, color = NEGRO) => {
    const s = limpiar(font, t);
    if (!s) return;
    page.drawText(s, { x: (PAG_W - font.widthOfTextAtSize(s, size)) / 2, y, font, size, color });
  };

  // Membrete
  if (membrete.nombre) { centrado(membrete.nombre, fB, 16); y -= 20; }
  if (membrete.ruc || membrete.direccion) {
    const partes = [membrete.ruc ? `RUC: ${membrete.ruc}` : null, membrete.direccion].filter(Boolean);
    for (const l of envolver(fN, partes.join('  ·  '), 10, ANCHO)) { centrado(l, fN, 10, GRIS); y -= 14; }
    y -= 20;
  }

  // Cuerpo: cada línea del texto; una línea vacía es un espacio entre párrafos
  for (const linea of cuerpo.split('\n')) {
    if (linea.trim() === '') { y -= INTERLINEADO * 0.7; continue; }
    for (const l of envolver(fN, linea, SIZE, ANCHO)) {
      nuevaPaginaSiHaceFalta(INTERLINEADO);
      page.drawText(l, { x: MARGEN, y, font: fN, size: SIZE, color: NEGRO });
      y -= INTERLINEADO;
    }
  }

  // Fecha y firma (se mantienen juntas en la misma página)
  nuevaPaginaSiHaceFalta(150);
  y -= 24;
  centrado(`${ciudad ? ciudad + ', ' : ''}${fechaHoy}`, fN, SIZE);
  y -= 56;
  centrado('_______________________________', fN, SIZE);
  y -= 16;
  if (firmaNombre) { centrado(firmaNombre, fB, SIZE); y -= 14; }
  if (firmaCedula) centrado(`Cédula: ${firmaCedula}`, fN, 10, GRIS);

  const bytes = await pdf.save();
  return { bytes, nombreArchivo: nombreArchivo(plantilla.nombre), mime: 'application/pdf' };
}