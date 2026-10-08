// functions/lib/imagenCuadro.js
// Genera una imagen PNG del cuadro, usando Satori (JSON tipo React
// → SVG) + @cf-wasm/resvg (SVG → PNG).
//
// npm install @cf-wasm/satori@0.4.0 --save-exact
// npm install @cf-wasm/resvg
//
// IMPORTANTE — versión fija de @cf-wasm/satori:
// Se usa la 0.4.0 EXACTA (trae satori 0.29, sin harfbuzzjs). Desde la
// 0.4.1 (satori 0.33.x) la primera generación de imagen falla en
// Cloudflare Workers/Pages con "Cannot read properties of undefined
// (reading 'href')". No actualizar sin confirmar antes que ese bug
// ya se resolvió.
//
// @cf-wasm/satori/workerd ya inicializa Yoga con el .wasm importado de
// forma estática, así que no hace falta initYoga ni parches.
// @cf-wasm/resvg (no @resvg/resvg-js): la segunda es un binario nativo
// que no corre en Cloudflare Workers.
//
// La fuente se descarga de un CDN en tiempo de ejecución (el bundler de
// Pages Functions no soporta imports binarios directos).
//
// SUBTÍTULO (parámetro opcional "subtitulo"): pensado para cuadros
// importados de una foto que trae fecha u otra aclaración debajo del
// título (ej. "15 de septiembre 2026"). Si no se pasa, el título se
// ve igual que antes.
//
// FILA DE TOTALES (parámetro "incluirTotales", true por defecto):
// suma cada columna numérica (todas las filas tienen que ser número
// en esa columna — igual de estricto que detectorFormulas.js, para
// no sumar algo que en realidad es texto). La primera columna dice
// "Total" en vez de sumarse. Si no hay ninguna columna numérica, o
// no hay filas, no se agrega nada.
//
// ENCABEZADO Y PIE (parámetro "extras", para facturas — salidas de
// tablaExtendida.js): el encabezado (negocio, RUC, cliente, fecha...) se
// dibuja ARRIBA de la tabla; el pie (Subtotal → ITBMS → Total a pagar)
// va como filas al final de la tabla, alineadas con las últimas
// columnas. Un dato que no se pudo leer con seguridad aparece como
// "por completar" en amarillo — nunca inventado. Con pie, la fila
// automática de Totales se omite (sumaría también Cant. y P. Unitario,
// que en una factura no tiene sentido). Sin extras, la imagen sale
// exactamente igual que siempre.
//
// LAYOUT — decisiones importantes:
// - La ALTURA no se fija: satori la calcula según el contenido. Con
//   altura fija, una fila cuyo texto se parte en 2 líneas (ej. un
//   nombre largo) empujaba al título y lo tapaba.
// - El ANCHO de cada columna es proporcional al texto más largo que
//   contiene (con tope), así "Nombre" recibe más espacio que "Abono".
// - El ANCHO total de la imagen crece si hacen falta muchas columnas
//   (entre 700 y 1100 px). Si aun así un texto no cabe, se parte en
//   varias líneas (wordBreak) y la altura se ajusta sola.

import { satori } from '@cf-wasm/satori/workerd';
import { Resvg } from '@cf-wasm/resvg/workerd';
import { recalcularPie } from './tablaExtendida.js';

const FUENTE_URL_REGULAR = 'https://cdn.jsdelivr.net/npm/@fontsource/roboto@5/files/roboto-latin-400-normal.woff';
const FUENTE_URL_BOLD    = 'https://cdn.jsdelivr.net/npm/@fontsource/roboto@5/files/roboto-latin-700-normal.woff';

// Cache a nivel de módulo — mientras el mismo "isolate" de Cloudflare
// siga vivo entre requests, no volvemos a descargar la fuente cada vez.
let fuenteRegularCache = null;
let fuenteBoldCache = null;

async function obtenerFuentes() {
  if (!fuenteRegularCache) {
    const res = await fetch(FUENTE_URL_REGULAR);
    if (!res.ok) throw new Error('No se pudo descargar la fuente Roboto (regular)');
    fuenteRegularCache = await res.arrayBuffer();
  }
  if (!fuenteBoldCache) {
    const res = await fetch(FUENTE_URL_BOLD);
    if (!res.ok) throw new Error('No se pudo descargar la fuente Roboto (bold)');
    fuenteBoldCache = await res.arrayBuffer();
  }
  return [fuenteRegularCache, fuenteBoldCache];
}

// Quita tildes/eñes para pasar de "Interés" (columna bonita) a
// "interes" (la clave real que usamos en calculo.js/buscarFila.js)
function aClaveInterna(columna) {
  return columna
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '') // quita paréntesis, %, etc.
    .trim()
    .replace(/\s+/g, '_'); // expr-eval no acepta espacios en un nombre de variable
}

// ── Medidas del layout (px) ──────────────────────────────────────
const PX_POR_CARACTER = 9;     // ancho aprox. de un carácter a 15-16 px
const PADDING_CELDA   = 24;    // 12 px a cada lado
const MAX_CARACTERES  = 28;    // una celda "pide" espacio hasta este tope
const MIN_CARACTERES  = 6;
const ANCHO_MIN       = 700;
const ANCHO_MAX       = 1100;
const MARGEN_EXTERNO  = 48;    // padding de 24 px a cada lado de la imagen

/**
 * @param {string} nombreCuadro
 * @param {string[]} columnas - nombres "bonitos" de columnas, en el orden a mostrar
 * @param {Object[]} filas - los datos, con claves internas (sin tildes, minúsculas)
 * @param {string} [subtitulo]
 * @param {boolean} [incluirTotales=true]
 * @param {Object} [extras] OPCIONAL, para facturas (misma forma que en excelCuadro.js):
 *   { encabezado: [{etiqueta,valor,pendiente}], pie: [{etiqueta,valor,formula,pendiente}] }.
 *   Un campo pendiente se dibuja como "por completar" en amarillo, nunca inventado.
 *   Sin extras, la imagen sale exactamente igual que siempre.
 * @returns {Promise<Uint8Array>} los bytes del PNG
 */
export async function generarImagenCuadro(nombreCuadro, columnas, filas, subtitulo, incluirTotales = true, extras = {}) {
  const [fuenteRegular, fuenteBold] = await obtenerFuentes();

  const encabezadoDoc = Array.isArray(extras?.encabezado) ? extras.encabezado : [];
  const pieDoc = Array.isArray(extras?.pie) ? extras.pie : [];
  const hayPie = pieDoc.length > 0;

  const clavesInternas = columnas.map(aClaveInterna);

  const filasFormateadas = filas.map(f =>
    clavesInternas.map(clave => {
      const valor = f[clave];
      return valor === undefined || valor === null ? '' : String(valor);
    })
  );

  // Fila de Totales: una columna se suma solo si TODAS las filas
  // tienen un número ahí (si alguna fila tiene texto o está vacía,
  // esa columna no se suma — mejor omitirla que sumar mal).
  let filaTotales = null;
  if (incluirTotales && !hayPie && filas.length > 0) {
    const sumas = clavesInternas.map((clave, j) => {
      if (j === 0) return null; // la primera columna lleva la etiqueta "Total", no se suma
      const todasNumericas = filas.every(f => typeof f[clave] === 'number' && Number.isFinite(f[clave]));
      if (!todasNumericas) return null;
      const suma = filas.reduce((acc, f) => acc + f[clave], 0);
      return Math.round(suma * 100) / 100;
    });
    if (sumas.some(v => v !== null)) {
      filaTotales = sumas.map((v, j) => (j === 0 ? 'Total' : v === null ? '' : String(v)));
    }
  }

  // Espacio que "pide" cada columna según su texto más largo
  // (encabezado incluido), con un mínimo y un tope.
  const pxPorColumna = columnas.map((col, j) => {
    const masLargo = Math.max(
      col.length,
      ...filasFormateadas.map(fila => fila[j].length)
    );
    const caracteres = Math.min(MAX_CARACTERES, Math.max(MIN_CARACTERES, masLargo));
    return caracteres * PX_POR_CARACTER + PADDING_CELDA;
  });

  const anchoNecesario = pxPorColumna.reduce((a, b) => a + b, 0) + MARGEN_EXTERNO;
  const ancho = Math.min(ANCHO_MAX, Math.max(ANCHO_MIN, anchoNecesario));

  // ── ENCABEZADO del documento (arriba de la tabla) ──
  const anchoEtiquetaEnc = Math.min(220, Math.max(110, Math.max(0, ...encabezadoDoc.map(c => String(c.etiqueta).length)) * 9 + 16));
  const marcaPendiente = (estilo = {}) => ({
    type: 'div',
    props: {
      style: {
        display: 'flex', backgroundColor: '#fff2cc', border: '1px solid #e0a800', borderRadius: 4,
        padding: '0 10px', color: '#8a6d00', fontSize: 14, fontWeight: 700, ...estilo,
      },
      children: 'por completar',
    },
  });
  const bloqueEncabezado = encabezadoDoc.length > 0 ? [{
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'column', flexShrink: 0, marginBottom: 16 },
      children: encabezadoDoc.map(campo => {
        const texto = campo.valor === null || campo.valor === undefined ? '' : String(campo.valor).trim();
        const pendiente = campo.pendiente === true || texto === '';
        return {
          type: 'div',
          props: {
            style: { display: 'flex', marginBottom: 4, fontSize: 15 },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', width: anchoEtiquetaEnc, flexShrink: 0, fontWeight: 700, color: '#444' },
                  children: String(campo.etiqueta),
                },
              },
              pendiente
                ? marcaPendiente()
                : { type: 'div', props: { style: { display: 'flex', flex: 1, color: '#1a1a1a', wordBreak: 'break-word' }, children: texto } },
            ],
          },
        };
      }),
    },
  }] : [];

  // ── PIE (filas al final de la tabla, alineadas con las últimas columnas) ──
  // Se recalcula con las líneas actuales para que la imagen y el Excel
  // nunca digan cosas distintas.
  const filasPie = [];
  if (hayPie) {
    const pieCalculado = recalcularPie(pieDoc, clavesInternas, filas);
    const nCols = columnas.length;
    // La etiqueta ocupa las 2 columnas anteriores a la última (para que
    // "TOTAL A PAGAR" no se parta en dos líneas); el valor, la última.
    const columnasEtiqueta = Math.min(2, Math.max(nCols - 1, 0));
    const flexValor = nCols >= 1 ? pxPorColumna[nCols - 1] : 1;
    const flexEtiqueta = columnasEtiqueta > 0
      ? pxPorColumna.slice(nCols - 1 - columnasEtiqueta, nCols - 1).reduce((a, b) => a + b, 0)
      : flexValor;
    const flexResto = pxPorColumna.slice(0, Math.max(nCols - 1 - columnasEtiqueta, 0)).reduce((a, b) => a + b, 0);
    const dinero = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    pieCalculado.forEach((fila, i) => {
      const esUltima = i === pieCalculado.length - 1;
      const pendiente = fila.pendiente || fila.valor === null || fila.valor === undefined;
      const textoValor = typeof fila.valor === 'number' ? dinero(fila.valor) : String(fila.valor ?? '');
      filasPie.push({
        type: 'div',
        props: {
          style: {
            display: 'flex',
            backgroundColor: esUltima ? '#eef2f7' : '#ffffff',
            borderTop: esUltima ? '2px solid #1a73e8' : '1px solid #eee',
          },
          children: [
            ...(flexResto > 0 ? [{ type: 'div', props: { style: { display: 'flex', flex: flexResto } } }] : []),
            {
              type: 'div',
              props: {
                style: {
                  display: 'flex', justifyContent: 'flex-end', flex: flexEtiqueta, padding: '10px 12px',
                  fontSize: 15, fontWeight: 700, color: '#1a1a1a', wordBreak: 'break-word',
                },
                children: String(fila.etiqueta),
              },
            },
            {
              type: 'div',
              props: {
                style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', flex: flexValor, padding: '10px 12px' },
                children: pendiente
                  ? marcaPendiente()
                  : { type: 'div', props: { style: { display: 'flex', fontSize: 15, fontWeight: 700, color: '#1a1a1a' }, children: textoValor } },
              },
            },
          ],
        },
      });
    });
  }

  const nodo = {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        backgroundColor: '#ffffff',
        padding: '24px',
        fontFamily: 'Roboto',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              fontSize: 28, fontWeight: 700, marginBottom: subtitulo ? 4 : 16, color: '#1a1a1a',
              display: 'flex', flexShrink: 0, wordBreak: 'break-word',
            },
            children: nombreCuadro,
          },
        },
        ...(subtitulo ? [{
          type: 'div',
          props: {
            style: { fontSize: 16, marginBottom: 16, color: '#666', display: 'flex', flexShrink: 0 },
            children: subtitulo,
          },
        }] : []),
        ...bloqueEncabezado,
        {
          type: 'div',
          props: {
            style: {
              display: 'flex', flexDirection: 'column', flexShrink: 0,
              border: '1px solid #ddd', borderRadius: 6, overflow: 'hidden',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', backgroundColor: '#1a73e8' },
                  children: columnas.map((col, j) => ({
                    type: 'div',
                    props: {
                      style: {
                        flex: pxPorColumna[j], padding: '10px 12px', color: '#fff',
                        fontWeight: 700, fontSize: 16, display: 'flex', wordBreak: 'break-word',
                      },
                      children: col,
                    },
                  })),
                },
              },
              ...filasFormateadas.map((fila, i) => ({
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    backgroundColor: i % 2 === 0 ? '#ffffff' : '#f5f7fa',
                    borderTop: '1px solid #eee',
                  },
                  children: fila.map((valor, j) => ({
                    type: 'div',
                    props: {
                      style: {
                        flex: pxPorColumna[j], padding: '10px 12px', fontSize: 15,
                        color: '#333', display: 'flex', wordBreak: 'break-word',
                      },
                      children: valor,
                    },
                  })),
                },
              })),
              ...filasPie,
              ...(filaTotales ? [{
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    backgroundColor: '#eef2f7',
                    borderTop: '2px solid #1a73e8',
                  },
                  children: filaTotales.map((valor, j) => ({
                    type: 'div',
                    props: {
                      style: {
                        flex: pxPorColumna[j], padding: '10px 12px', fontSize: 15, fontWeight: 700,
                        color: '#1a1a1a', display: 'flex', wordBreak: 'break-word',
                      },
                      children: valor,
                    },
                  })),
                },
              }] : []),
            ],
          },
        },
      ],
    },
  };

  // Sin "height": satori calcula la altura según el contenido.
  const svg = await satori(nodo, {
    width: ancho,
    fonts: [
      { name: 'Roboto', data: fuenteRegular, weight: 400, style: 'normal' },
      { name: 'Roboto', data: fuenteBold, weight: 700, style: 'normal' },
    ],
  });

  const resvg = await Resvg.async(svg, { fitTo: { mode: 'width', value: ancho } });
  return resvg.render().asPng();
}