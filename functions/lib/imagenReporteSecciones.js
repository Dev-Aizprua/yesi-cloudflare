// functions/lib/imagenReporteSecciones.js
// Genera una imagen PNG del reporte tipo "secciones" (ej. Pago de
// Quincena), reusando exactamente el mismo motor y estilo visual que
// imagenCuadro.js (Satori + @cf-wasm/resvg, misma fuente Roboto, mismo
// azul de encabezado #1a73e8, mismas filas alternadas).
//
// A diferencia de imagenCuadro.js (N columnas, definidas por el cuadro),
// aquí el layout es SIEMPRE de 2 columnas fijas: Etiqueta / Valor. Los
// nombres de sección ("DETALLE", "CUADRO DE DEUDA ANTERIOR") se dibujan
// como una fila especial que ocupa las DOS columnas, en negrita, con el
// mismo fondo azul que usa el encabezado en imagenCuadro.js — así una
// sección se distingue de un simple par etiqueta/valor.
//
// Este archivo recibe el reporte YA VALIDADO por reporteSecciones.js
// (validarReporteSecciones) — aquí no se valida ni se calcula nada, solo
// se dibuja lo que ya viene resuelto. El campo `formula` de cada fila no
// afecta el dibujo (eso solo le importa a excelReporteSecciones.js).
//
// Las estadísticas de resumen (ej. "CAPITAL: 11,142") se dibujan ANTES
// de la tabla de secciones, en un recuadro destacado (fondo celeste,
// texto azul y más grande) — así se distinguen de una fila cualquiera,
// igual que se ven "destacadas" en la foto original.
//
// npm install @cf-wasm/satori@0.4.0 --save-exact
// npm install @cf-wasm/resvg
// (mismas versiones fijas que imagenCuadro.js — ver ese archivo para el
// motivo de fijar @cf-wasm/satori en 0.4.0 exacto)

import { satori } from '@cf-wasm/satori/workerd';
import { Resvg } from '@cf-wasm/resvg/workerd';

const FUENTE_URL_REGULAR = 'https://cdn.jsdelivr.net/npm/@fontsource/roboto@5/files/roboto-latin-400-normal.woff';
const FUENTE_URL_BOLD    = 'https://cdn.jsdelivr.net/npm/@fontsource/roboto@5/files/roboto-latin-700-normal.woff';

// Misma cache a nivel de módulo que imagenCuadro.js — si ambos archivos
// corren en el mismo isolate, cada uno mantiene su propia copia (son
// módulos distintos), pero cada uno descarga la fuente una sola vez.
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

// ── Medidas del layout (px) ──────────────────────────────────────
// Mismos PX_POR_CARACTER/PADDING_CELDA que imagenCuadro.js (misma
// fuente, mismo tamaño de letra) — solo cambian los topes de caracteres
// y el ancho total, porque acá son 2 columnas fijas en vez de N.
const PX_POR_CARACTER = 9;
const PADDING_CELDA   = 24;
const MARGEN_EXTERNO  = 48;

const MIN_CARACTERES_ETIQUETA = 8;
const MAX_CARACTERES_ETIQUETA = 42; // etiquetas largas, ej. "Nuevo saldo para el 31 de Agosto del 2026"
const MIN_CARACTERES_VALOR    = 6;
const MAX_CARACTERES_VALOR    = 20;
const ANCHO_MIN = 500; // más angosto que imagenCuadro.js: 2 columnas, no N
const ANCHO_MAX = 900;

function formatearValor(valor) {
  return valor === undefined || valor === null ? '' : String(valor);
}

// Calcula el ancho (px) de las columnas Etiqueta/Valor y el ancho total
// de la imagen, según el texto más largo que va a mostrarse. Separado
// de generarImagenReporteSecciones() para poder probarlo sin necesitar
// Satori/resvg (que no corren fuera de Cloudflare Workers).
export function calcularAnchosSecciones(estadisticas, secciones) {
  const etiquetas = [];
  const valores = [];

  for (const seccion of secciones) {
    for (const fila of seccion.filas) {
      etiquetas.push(fila.etiqueta);
      valores.push(formatearValor(fila.valor));
    }
  }
  // Las estadísticas de resumen no forman parte de la tabla de 2
  // columnas (se dibujan aparte, destacadas), pero igual cuentan para
  // que la imagen no quede más angosta que el texto de la estadística.
  const anchoEstadisticas = estadisticas.reduce(
    (max, e) => Math.max(max, `${e.etiqueta}: ${formatearValor(e.valor)}`.length),
    0
  );

  const largoEtiqueta = etiquetas.reduce((max, t) => Math.max(max, t.length), 0);
  const largoValor = valores.reduce((max, t) => Math.max(max, t.length), 0);

  const caracteresEtiqueta = Math.min(MAX_CARACTERES_ETIQUETA, Math.max(MIN_CARACTERES_ETIQUETA, largoEtiqueta));
  const caracteresValor = Math.min(MAX_CARACTERES_VALOR, Math.max(MIN_CARACTERES_VALOR, largoValor));

  const pxEtiqueta = caracteresEtiqueta * PX_POR_CARACTER + PADDING_CELDA;
  const pxValor = caracteresValor * PX_POR_CARACTER + PADDING_CELDA;

  const anchoNecesario = Math.max(
    pxEtiqueta + pxValor + MARGEN_EXTERNO,
    anchoEstadisticas * PX_POR_CARACTER + MARGEN_EXTERNO
  );
  const ancho = Math.min(ANCHO_MAX, Math.max(ANCHO_MIN, anchoNecesario));

  return { pxEtiqueta, pxValor, ancho };
}

/**
 * @param {Object} reporte - la salida de validarReporteSecciones() en reporteSecciones.js
 * @param {string} reporte.titulo
 * @param {string} [reporte.subtitulo]
 * @param {Array<{etiqueta: string, valor: any}>} reporte.estadisticas
 * @param {Array<{nombre: string, filas: Array<{etiqueta: string, valor: any}>}>} reporte.secciones
 * @returns {Promise<Uint8Array>} los bytes del PNG
 */
export async function generarImagenReporteSecciones(reporte) {
  const { titulo, subtitulo, estadisticas, secciones } = reporte;
  const [fuenteRegular, fuenteBold] = await obtenerFuentes();

  const { pxEtiqueta, pxValor, ancho } = calcularAnchosSecciones(estadisticas, secciones);

  // Filas de datos de TODAS las secciones, con su índice global — así
  // el alternado de color sigue corrido de una sección a la siguiente,
  // en vez de reiniciar en blanco al empezar cada sección.
  let indiceFilaGlobal = 0;
  const bloquesSecciones = secciones.flatMap(seccion => {
    const encabezadoSeccion = {
      type: 'div',
      props: {
        style: {
          display: 'flex', backgroundColor: '#1a73e8', borderTop: '1px solid #eee',
        },
        children: [{
          type: 'div',
          props: {
            style: {
              flex: pxEtiqueta + pxValor, padding: '10px 12px', color: '#fff',
              fontWeight: 700, fontSize: 16, display: 'flex', wordBreak: 'break-word',
            },
            children: seccion.nombre,
          },
        }],
      },
    };

    const filasSeccion = seccion.filas.map(fila => {
      const filaNodo = {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            backgroundColor: indiceFilaGlobal % 2 === 0 ? '#ffffff' : '#f5f7fa',
            borderTop: '1px solid #eee',
          },
          children: [
            {
              type: 'div',
              props: {
                style: {
                  flex: pxEtiqueta, padding: '10px 12px', fontSize: 15,
                  color: '#333', display: 'flex', wordBreak: 'break-word',
                },
                children: fila.etiqueta,
              },
            },
            {
              type: 'div',
              props: {
                style: {
                  flex: pxValor, padding: '10px 12px', fontSize: 15,
                  color: '#333', display: 'flex', wordBreak: 'break-word',
                },
                children: formatearValor(fila.valor),
              },
            },
          ],
        },
      };
      indiceFilaGlobal += 1;
      return filaNodo;
    });

    return [encabezadoSeccion, ...filasSeccion];
  });

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
            children: titulo,
          },
        },
        ...(subtitulo ? [{
          type: 'div',
          props: {
            style: { fontSize: 16, marginBottom: 16, color: '#666', display: 'flex', flexShrink: 0 },
            children: subtitulo,
          },
        }] : []),
        // Estadísticas de resumen, destacadas — fuera de la tabla de secciones
        ...(estadisticas.length > 0 ? [{
          type: 'div',
          props: {
            style: {
              display: 'flex', flexDirection: 'column', flexShrink: 0,
              backgroundColor: '#eaf2fe', border: '1px solid #b8d4fb', borderRadius: 6,
              padding: '12px 16px', marginBottom: 16,
            },
            children: estadisticas.map(e => ({
              type: 'div',
              props: {
                style: {
                  fontSize: 20, fontWeight: 700, color: '#1a73e8',
                  display: 'flex', wordBreak: 'break-word',
                },
                children: `${e.etiqueta}: ${formatearValor(e.valor)}`,
              },
            })),
          },
        }] : []),
        // Tabla de secciones (2 columnas fijas + filas de encabezado de sección)
        {
          type: 'div',
          props: {
            style: {
              display: 'flex', flexDirection: 'column', flexShrink: 0,
              border: '1px solid #ddd', borderRadius: 6, overflow: 'hidden',
            },
            children: bloquesSecciones,
          },
        },
      ],
    },
  };

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