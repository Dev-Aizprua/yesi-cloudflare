// functions/lib/excelReporteSecciones.js
// Genera un archivo Excel (.xlsx) del reporte tipo "secciones" (ej. Pago
// de Quincena), con FÓRMULAS REALES donde reporteSecciones.js las validó.
//
// Reusa exactamente el mismo patrón que excelCuadro.js: título/subtítulo
// combinados arriba (mismo FILA_TITULO/FILA_SUBTITULO), nombres de
// sección en negrita con fondo azul (mismo ESTILO_ENCABEZADO), y el
// mismo criterio de "si no se puede traducir con seguridad, valor fijo
// en vez de arriesgar una fórmula equivocada".
//
// DIFERENCIA CLAVE con excelCuadro.js: allá todas las fórmulas de una
// fila usan la MISMA fila de Excel (una tabla, columna×fila). Acá cada
// identificador (ej. "resumen_capital", "capital") vive en una fila
// DISTINTA de la hoja (una estadística de resumen, o una fila de una
// sección) — así que en vez de un mapa "clave → letra de columna" se
// arma un mapa "clave → dirección de celda completa" (ej. "B2", "B5"),
// que se va llenando fila por fila, EN EL MISMO ORDEN en que
// reporteSecciones.js construyó su contexto de validación. Por eso
// nunca falla la traducción de una fórmula ya validada: usa exactamente
// las mismas claves, disponibles en el mismo momento.
//
// Este archivo recibe el reporte YA VALIDADO por reporteSecciones.js
// (validarReporteSecciones) — aquí no se valida ni se decide nada nuevo,
// solo se traduce la fórmula ya aceptada a sintaxis de Excel.

import * as XLSX from 'xlsx-js-style';

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const COL_ETIQUETA = 0;
const COL_VALOR = 1;
const ULTIMA_COLUMNA = 1; // 2 columnas fijas: Etiqueta / Valor

// ── Estilos — mismos colores/fuente que excelCuadro.js ───────────
const ESTILO_TITULO = {
  font: { name: 'Arial', bold: true, sz: 16, color: { rgb: '1A1A1A' } },
  alignment: { horizontal: 'left', vertical: 'center' },
};
const ESTILO_SUBTITULO = {
  font: { name: 'Arial', sz: 11, color: { rgb: '666666' } },
  alignment: { horizontal: 'left', vertical: 'center' },
};
const ESTILO_ENCABEZADO_SECCION = {
  font: { name: 'Arial', bold: true, sz: 11, color: { rgb: 'FFFFFF' } },
  fill: { patternType: 'solid', fgColor: { rgb: '1A73E8' } },
  alignment: { horizontal: 'left', vertical: 'center' },
};
// Estadística de resumen destacada — mismo celeste que el recuadro de
// imagenReporteSecciones.js (#eaf2fe), en vez del azul sólido de un
// encabezado, para que en la imagen y el Excel se lea igual: "esto es
// un dato destacado", no "esto es un título de sección".
const ESTILO_ESTADISTICA_ETIQUETA = {
  font: { name: 'Arial', bold: true, sz: 12, color: { rgb: '1A73E8' } },
  fill: { patternType: 'solid', fgColor: { rgb: 'EAF2FE' } },
  alignment: { horizontal: 'left', vertical: 'center' },
};
const ESTILO_ESTADISTICA_VALOR = {
  font: { name: 'Arial', bold: true, sz: 12, color: { rgb: '1A73E8' } },
  fill: { patternType: 'solid', fgColor: { rgb: 'EAF2FE' } },
  alignment: { horizontal: 'right', vertical: 'center' },
};

// Funciones de expr-eval con equivalente EXACTO en Excel — misma lista
// que excelCuadro.js (traducirFormula).
const FUNCIONES_EXCEL = {
  min: 'MIN',
  max: 'MAX',
  abs: 'ABS',
  sqrt: 'SQRT',
  pow: 'POWER',
};

function aClave(texto) {
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_');
}

// Traduce una fórmula YA VALIDADA (viene de reporteSecciones.js, así
// que sus identificadores son siempre claves válidas: "resumen_capital",
// "capital", etc.) a fórmula de Excel, usando un mapa de "clave →
// dirección de celda" en vez de "clave → letra de columna" (ver nota de
// arriba). Si un identificador no está en el mapa (no debería pasar con
// una fórmula ya validada, pero no se arriesga) o aparece un operador no
// traducible, se descarta — mismo criterio de excelCuadro.js.
const TOKEN_RE = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_$][A-Za-z0-9_$]*)|([+\-*\/^(),]))/y;

export function traducirFormulaSecciones(formula, referencias) {
  let salida = '';
  let pos = 0;
  const texto = String(formula).trimEnd();

  while (pos < texto.length) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(texto);
    if (!m) return null;
    pos = TOKEN_RE.lastIndex;

    if (m[1] !== undefined) {
      salida += m[1];
    } else if (m[2] !== undefined) {
      const id = m[2];
      const siguiente = texto.slice(pos).match(/^\s*(.)/);
      const esFuncion = siguiente && siguiente[1] === '(';
      if (esFuncion) {
        const f = FUNCIONES_EXCEL[id.toLowerCase()];
        if (!f) return null;
        salida += f;
      } else {
        const ref = referencias[id];
        if (!ref) return null; // clave desconocida en este punto — no se arriesga
        salida += ref;
      }
    } else {
      salida += m[3];
    }
  }
  return salida.length ? salida : null;
}

function nombreHoja(titulo) {
  const limpio = String(titulo).replace(/[\\\/?*\[\]:]/g, '').trim().slice(0, 31);
  return limpio || 'Reporte';
}

function nombreArchivo(titulo) {
  const base = aClave(titulo).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${base || 'reporte'}.xlsx`;
}

/**
 * @param {Object} reporte - la salida de validarReporteSecciones() en reporteSecciones.js
 * @returns {{ bytes: Uint8Array, nombreArchivo: string, mime: string, filasSinFormula: string[] }}
 *   filasSinFormula: filas donde Groq SÍ sugirió una fórmula pero no
 *   pasó la verificación (no las filas que nunca tuvieron fórmula —
 *   esas son datos crudos de la foto, no un aviso que darle al usuario).
 */
export function generarExcelReporteSecciones(reporte) {
  const { titulo, subtitulo, estadisticas, secciones } = reporte;

  const ws = {};
  ws['!merges'] = [];
  const filasSinFormula = [];

  // Fila actual en SheetJS (base 0) — se va incrementando a medida que
  // se escribe cada bloque, igual que PRIMERA_FILA_DATOS en excelCuadro.js.
  let filaActual = 0;

  const FILA_TITULO = filaActual++;
  ws[XLSX.utils.encode_cell({ r: FILA_TITULO, c: 0 })] = { t: 's', v: String(titulo), s: ESTILO_TITULO };
  ws['!merges'].push({ s: { r: FILA_TITULO, c: 0 }, e: { r: FILA_TITULO, c: ULTIMA_COLUMNA } });

  if (subtitulo) {
    const FILA_SUBTITULO = filaActual++;
    ws[XLSX.utils.encode_cell({ r: FILA_SUBTITULO, c: 0 })] = { t: 's', v: String(subtitulo), s: ESTILO_SUBTITULO };
    ws['!merges'].push({ s: { r: FILA_SUBTITULO, c: 0 }, e: { r: FILA_SUBTITULO, c: ULTIMA_COLUMNA } });
  }

  filaActual += 1; // fila en blanco, mismo espaciado que excelCuadro.js antes del encabezado

  // Mapa "clave → dirección de celda" que se va llenando EN EL MISMO
  // ORDEN en que reporteSecciones.js arma su contexto de validación:
  // primero todas las estadísticas de resumen, después las filas de
  // cada sección (reiniciando la parte local en cada sección nueva).
  const referenciasResumen = {};

  for (const e of (estadisticas || [])) {
    const fila = filaActual++;
    const filaExcel = fila + 1; // SheetJS es base 0, Excel se ve base 1
    ws[XLSX.utils.encode_cell({ r: fila, c: COL_ETIQUETA })] = { t: 's', v: e.etiqueta, s: ESTILO_ESTADISTICA_ETIQUETA };
    if (typeof e.valor === 'number') {
      ws[XLSX.utils.encode_cell({ r: fila, c: COL_VALOR })] = { t: 'n', v: e.valor, s: ESTILO_ESTADISTICA_VALOR };
      referenciasResumen[e.clave] = `B${filaExcel}`;
    } else {
      ws[XLSX.utils.encode_cell({ r: fila, c: COL_VALOR })] = { t: 's', v: String(e.valor ?? ''), s: ESTILO_ESTADISTICA_VALOR };
    }
  }

  if ((estadisticas || []).length > 0) filaActual += 1; // fila en blanco antes de la tabla de secciones

  for (const seccion of (secciones || [])) {
    const filaEncabezado = filaActual++;
    ws[XLSX.utils.encode_cell({ r: filaEncabezado, c: 0 })] = { t: 's', v: seccion.nombre, s: ESTILO_ENCABEZADO_SECCION };
    ws['!merges'].push({ s: { r: filaEncabezado, c: 0 }, e: { r: filaEncabezado, c: ULTIMA_COLUMNA } });

    // Arranca solo con las estadísticas de resumen — nunca hereda
    // referencias de la sección anterior (mismo escope que
    // reporteSecciones.js: una fórmula nunca cruza de una sección a otra).
    const referenciasSeccion = { ...referenciasResumen };

    for (const fila of (seccion.filas || [])) {
      const filaHoja = filaActual++;
      const filaExcel = filaHoja + 1;
      const refValor = `B${filaExcel}`;

      ws[XLSX.utils.encode_cell({ r: filaHoja, c: COL_ETIQUETA })] = { t: 's', v: fila.etiqueta };

      if (fila.formula) {
        const traducida = traducirFormulaSecciones(fila.formula, referenciasSeccion);
        if (traducida && typeof fila.valor === 'number') {
          ws[XLSX.utils.encode_cell({ r: filaHoja, c: COL_VALOR })] = { t: 'n', v: fila.valor, f: `ROUND(${traducida},2)` };
        } else {
          // No debería pasar (la fórmula ya viene validada), pero si
          // por algo no se puede traducir, se entrega el valor fijo y
          // se avisa — nunca se arriesga una fórmula incorrecta.
          escribirValorFijo(ws, filaHoja, fila.valor);
          filasSinFormula.push(`${seccion.nombre} > ${fila.etiqueta}`);
        }
      } else {
        escribirValorFijo(ws, filaHoja, fila.valor);
        // Solo se avisa si SÍ se había sugerido una fórmula y no cuadró
        // — una fila que nunca tuvo fórmula (un dato crudo de la foto)
        // no es una fórmula "faltante", es un valor que siempre fue fijo.
        if (fila.formulaOriginal) {
          filasSinFormula.push(`${seccion.nombre} > ${fila.etiqueta}`);
        }
      }

      // Disponible para las filas SIGUIENTES de esta misma sección,
      // igual que en reporteSecciones.js.
      referenciasSeccion[fila.clave] = refValor;
    }
  }

  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: Math.max(filaActual - 1, 0), c: ULTIMA_COLUMNA },
  });

  ws['!rows'] = [];
  ws['!rows'][FILA_TITULO] = { hpt: 28 };

  // Ancho de columnas según el texto más largo de cada una (mismo
  // criterio que excelCuadro.js).
  const etiquetas = [titulo, subtitulo, ...(estadisticas || []).map(e => e.etiqueta), ...(secciones || []).flatMap(s => [s.nombre, ...s.filas.map(f => f.etiqueta)])].filter(Boolean);
  const valores = [...(estadisticas || []).map(e => String(e.valor ?? '')), ...(secciones || []).flatMap(s => s.filas.map(f => String(f.valor ?? '')))];
  ws['!cols'] = [
    { wch: Math.min(50, Math.max(14, Math.max(...etiquetas.map(t => String(t).length), 10) + 2)) },
    { wch: Math.min(24, Math.max(10, Math.max(...valores.map(v => v.length), 6) + 2)) },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, nombreHoja(titulo));
  const salida = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true });

  return {
    bytes: new Uint8Array(salida),
    nombreArchivo: nombreArchivo(titulo),
    mime: MIME_XLSX,
    filasSinFormula,
  };
}

function escribirValorFijo(ws, filaHoja, valor) {
  const ref = XLSX.utils.encode_cell({ r: filaHoja, c: COL_VALOR });
  if (valor === undefined || valor === null || valor === '') return;
  ws[ref] = typeof valor === 'number' ? { t: 'n', v: valor } : { t: 's', v: String(valor) };
}