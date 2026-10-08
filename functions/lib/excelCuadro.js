// functions/lib/excelCuadro.js
// Genera un archivo Excel (.xlsx) del cuadro, con FÓRMULAS REALES.
//
// npm install xlsx-js-style
//   (versión compatible con `xlsx`/SheetJS que además permite dar formato:
//    negrita, tamaño, colores. Si estaba instalada `xlsx`, desinstalarla:
//    npm uninstall xlsx)
//
// Las fórmulas NO las escribe Groq: salen de las mismas reglas_calculo
// que ya guarda crear_cuadro y que calculo.js usa para calcular. Aquí
// solo se TRADUCEN a sintaxis de Excel (ej. "monto + interes - abono"
// → "=ROUND(B2+C2-D2,2)").
//
// Cada celda de fórmula también lleva el valor ya calculado por
// calculo.js (el "valor en caché"), así el archivo se ve bien aunque
// se abra en una vista previa que no recalcula (WhatsApp, correo,
// etc.). Al abrirlo en Excel/Sheets/LibreOffice sigue siendo fórmula
// real: si el usuario cambia un abono, el saldo se recalcula solo.
//
// DISEÑO DE LA HOJA (con parámetro opcional "subtitulo", ej. una fecha):
//   fila 1: título (nombre del cuadro), combinado a lo ancho de la tabla
//   fila 2: subtítulo, si se pasó uno (si no, esta fila no existe)
//   fila siguiente: en blanco
//   fila siguiente: encabezados (azul, texto blanco — igual que la imagen)
//   filas siguientes: registros
//
// ROUND(...,2) replica el redondeo a 2 decimales de calculo.js, para
// que el Excel y la imagen den siempre el MISMO número.
//
// Si una regla usa algo que no se puede traducir con seguridad (ej.
// el operador % de expr-eval, que es módulo y en Excel significa otra
// cosa), esa columna se entrega con VALORES FIJOS en vez de fórmula,
// y la función lo reporta en `columnasSinFormula` — nunca se entrega
// una fórmula que calcule algo distinto a la imagen.

import * as XLSX from 'xlsx-js-style';
import { recalcularCuadro } from './calculo.js';
import { recalcularPie } from './tablaExtendida.js';
import { traducirFormulaSecciones } from './excelReporteSecciones.js';

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Posiciones (base 0 para SheetJS; en Excel se ven como fila 1, 3 y 4)
// Estas posiciones se calculan según si hay subtítulo o no, y según
// cuántos campos de ENCABEZADO DEL DOCUMENTO (negocio, RUC, cliente...)
// hay arriba de la tabla — ver calcularFilas() más abajo. Sin
// encabezado el resultado es EXACTAMENTE el de siempre.
function calcularFilas(hayISubtitulo, camposEncabezado = 0) {
  const FILA_TITULO = 0;
  const FILA_SUBTITULO = hayISubtitulo ? 1 : null;
  const FILA_INICIO_ENCABEZADO_DOC = hayISubtitulo ? 3 : 2; // después de la fila en blanco
  // los campos del encabezado + 1 fila en blanco antes de la tabla
  const filasEncabezadoDoc = camposEncabezado > 0 ? camposEncabezado + 1 : 0;
  const FILA_ENCABEZADO = FILA_INICIO_ENCABEZADO_DOC + filasEncabezadoDoc;
  const PRIMERA_FILA_DATOS = FILA_ENCABEZADO + 1;
  return { FILA_TITULO, FILA_SUBTITULO, FILA_INICIO_ENCABEZADO_DOC, FILA_ENCABEZADO, PRIMERA_FILA_DATOS };
}

// Estilos de encabezado del documento y pie de cálculos (factura).
// Un campo PENDIENTE (dato que no se leyó con seguridad) se pinta de
// amarillo y va vacío: el usuario lo completa a mano en Excel.
const ESTILO_ENC_ETIQUETA = {
  font: { name: 'Arial', bold: true, sz: 11, color: { rgb: '444444' } },
  alignment: { horizontal: 'left', vertical: 'center' },
};
const ESTILO_ENC_VALOR = {
  font: { name: 'Arial', sz: 11, color: { rgb: '1A1A1A' } },
  alignment: { horizontal: 'left', vertical: 'center' },
};
const ESTILO_PENDIENTE = {
  fill: { patternType: 'solid', fgColor: { rgb: 'FFF2CC' } },
  border: {
    top: { style: 'thin', color: { rgb: 'E0A800' } },
    bottom: { style: 'thin', color: { rgb: 'E0A800' } },
    left: { style: 'thin', color: { rgb: 'E0A800' } },
    right: { style: 'thin', color: { rgb: 'E0A800' } },
  },
};
const ESTILO_PIE_ETIQUETA = {
  font: { name: 'Arial', bold: true, sz: 11, color: { rgb: '1A1A1A' } },
  alignment: { horizontal: 'right', vertical: 'center' },
};
const ESTILO_PIE_VALOR = {
  font: { name: 'Arial', bold: true, sz: 11, color: { rgb: '1A1A1A' } },
  alignment: { horizontal: 'right', vertical: 'center' },
};
// Dinero del pie con 2 decimales (17.50, no 17.5). Solo formato de
// visualización: el valor y la fórmula no cambian.
const FORMATO_DINERO = '#,##0.00';
// Con encabezado de documento la 1ª columna se ensancha (lleva las
// etiquetas), así que los números de línea ("#") se centran para que no
// queden pegados a la descripción.
const ESTILO_INDICE_CENTRADO = { alignment: { horizontal: 'center', vertical: 'center' } };
// La ÚLTIMA fila del pie (el total a pagar) se destaca igual que la fila de Totales
const ESTILO_PIE_FINAL_ETIQUETA = {
  ...ESTILO_PIE_ETIQUETA,
  fill: { patternType: 'solid', fgColor: { rgb: 'EEF2F7' } },
  border: { top: { style: 'medium', color: { rgb: '1A73E8' } } },
};
const ESTILO_PIE_FINAL_VALOR = {
  ...ESTILO_PIE_VALOR,
  fill: { patternType: 'solid', fgColor: { rgb: 'EEF2F7' } },
  border: { top: { style: 'medium', color: { rgb: '1A73E8' } } },
};

const ESTILO_SUBTITULO = {
  font: { name: 'Arial', sz: 11, color: { rgb: '666666' } },
  alignment: { horizontal: 'left', vertical: 'center' },
};
const ESTILO_TOTAL = {
  font: { name: 'Arial', bold: true, sz: 11, color: { rgb: '1A1A1A' } },
  fill: { patternType: 'solid', fgColor: { rgb: 'EEF2F7' } },
  border: { top: { style: 'medium', color: { rgb: '1A73E8' } } },
  alignment: { horizontal: 'left', vertical: 'center' },
};

const ESTILO_TITULO = {
  font: { name: 'Arial', bold: true, sz: 16, color: { rgb: '1A1A1A' } },
  alignment: { horizontal: 'left', vertical: 'center' },
};
const ESTILO_ENCABEZADO = {
  font: { name: 'Arial', bold: true, sz: 11, color: { rgb: 'FFFFFF' } },
  fill: { patternType: 'solid', fgColor: { rgb: '1A73E8' } },
  alignment: { horizontal: 'left', vertical: 'center' },
};

// Funciones de expr-eval que tienen equivalente EXACTO en Excel.
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
    .replace(/[^a-z0-9\s]/g, '') // quita paréntesis, %, etc.
    .trim()
    .replace(/\s+/g, '_'); // expr-eval no acepta espacios en un nombre de variable
}

/**
 * Traduce una fórmula de expr-eval a fórmula de Excel para una fila.
 * @param {string} formula   ej. "monto + interes - abono"
 * @param {Object} letras    clave de columna → letra, ej. { monto: 'B', ... }
 * @param {number} filaExcel número de fila en la hoja (2 = primer registro)
 * @returns {string|null} fórmula sin "=", o null si no se puede traducir con seguridad
 */
export function traducirFormula(formula, letras, filaExcel) {
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_$][A-Za-z0-9_$]*)|([+\-*\/^(),]))/y;
  let salida = '';
  let pos = 0;
  const texto = String(formula).trimEnd();

  while (pos < texto.length) {
    re.lastIndex = pos;
    const m = re.exec(texto);
    if (!m) return null; // carácter no soportado (%, ?, :, <, >, =, etc.)
    pos = re.lastIndex;

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
        const letra = letras[id];
        if (!letra) return null; // variable desconocida → no arriesgamos
        salida += `${letra}${filaExcel}`;
      }
    } else {
      salida += m[3];
    }
  }
  return salida.length ? salida : null;
}

function nombreHoja(nombreCuadro) {
  const limpio = String(nombreCuadro).replace(/[\\\/?*\[\]:]/g, '').trim().slice(0, 31);
  return limpio || 'Cuadro';
}

function nombreArchivo(nombreCuadro) {
  const base = aClave(nombreCuadro)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${base || 'cuadro'}.xlsx`;
}

/**
 * @param {string} nombreCuadro
 * @param {string[]} columnas  nombres "bonitos", en orden
 * @param {Object[]} filas     datos con claves internas (sin tildes, minúsculas)
 * @param {Object} reglas      reglas_calculo del cuadro, ej. { interes: "monto * 0.10", saldo: "..." }
 * @param {string} [subtitulo]
 * @param {boolean} [incluirTotales=true]  fila de Totales automática (se omite sola si hay pie)
 * @param {Object} [extras]    OPCIONAL, para facturas (salidas de tablaExtendida.js):
 *   - encabezado: [{ etiqueta, valor, pendiente }] — datos arriba de la tabla. Un campo
 *     pendiente va vacío y en amarillo, nunca inventado.
 *   - pie: [{ etiqueta, clave, valor, formula, formulaOriginal, pendiente }] — cadena de
 *     cálculos debajo de la tabla, con fórmulas reales de Excel donde se validaron.
 *   Sin extras el archivo sale exactamente igual que siempre.
 * @returns {{ bytes: Uint8Array, nombreArchivo: string, mime: string, columnasSinFormula: string[],
 *   camposPendientes: string[], pieSinFormula: string[] }}
 *   camposPendientes: etiquetas que quedaron vacías (encabezado o pie) por no leerse con seguridad.
 *   pieSinFormula: filas del pie donde se sugirió una fórmula pero quedó valor fijo.
 */
export function generarExcelCuadro(nombreCuadro, columnas, filas, reglas, subtitulo, incluirTotales = true, extras = {}) {
  // Recalculamos con calculo.js para que los valores en caché
  // coincidan exactamente con las fórmulas.
  const filasCalculadas = recalcularCuadro(filas, reglas || {});

  // ENCABEZADO y PIE opcionales (facturas). Sin ellos, todo lo de abajo
  // se comporta exactamente como siempre.
  const encabezadoDoc = Array.isArray(extras?.encabezado) ? extras.encabezado : [];
  const pieDoc = Array.isArray(extras?.pie) ? extras.pie : [];
  const hayPie = pieDoc.length > 0;
  const hayExtras = encabezadoDoc.length > 0 || hayPie;
  const camposPendientes = []; // etiquetas que quedaron vacías por no leerse con seguridad
  const pieSinFormula = [];    // filas del pie que quedaron con valor fijo aunque se sugirió una fórmula

  const claves = columnas.map(aClave);
  const letras = {};
  claves.forEach((k, j) => { letras[k] = XLSX.utils.encode_col(j); });

  const ws = {};
  const columnasSinFormula = new Set();

  // Con encabezado o pie hacen falta al menos 2 columnas (etiqueta y valor)
  const ultimaColumna = Math.max(columnas.length - 1, hayExtras ? 1 : 0);
  const { FILA_TITULO, FILA_SUBTITULO, FILA_INICIO_ENCABEZADO_DOC, FILA_ENCABEZADO, PRIMERA_FILA_DATOS } =
    calcularFilas(!!subtitulo, encabezadoDoc.length);
  ws['!merges'] = [];

  // Título, combinado a lo ancho de la tabla
  ws[XLSX.utils.encode_cell({ r: FILA_TITULO, c: 0 })] = { t: 's', v: String(nombreCuadro), s: ESTILO_TITULO };
  if (ultimaColumna > 0) {
    ws['!merges'].push({ s: { r: FILA_TITULO, c: 0 }, e: { r: FILA_TITULO, c: ultimaColumna } });
  }

  // Subtítulo, si se pasó uno
  if (subtitulo) {
    ws[XLSX.utils.encode_cell({ r: FILA_SUBTITULO, c: 0 })] = { t: 's', v: String(subtitulo), s: ESTILO_SUBTITULO };
    if (ultimaColumna > 0) {
      ws['!merges'].push({ s: { r: FILA_SUBTITULO, c: 0 }, e: { r: FILA_SUBTITULO, c: ultimaColumna } });
    }
  }

  // Encabezado del documento (negocio, RUC, cliente, fecha...): etiqueta
  // en la 1ª columna, valor combinado hasta el final de la tabla. Un
  // campo pendiente va VACÍO y en amarillo — nunca se rellena con un
  // valor inventado.
  encabezadoDoc.forEach((campo, k) => {
    const r = FILA_INICIO_ENCABEZADO_DOC + k;
    const texto = campo.valor === null || campo.valor === undefined ? '' : String(campo.valor).trim();
    const pendiente = campo.pendiente === true || texto === '';
    ws[XLSX.utils.encode_cell({ r, c: 0 })] = { t: 's', v: String(campo.etiqueta), s: ESTILO_ENC_ETIQUETA };
    ws[XLSX.utils.encode_cell({ r, c: 1 })] = pendiente
      ? { t: 's', v: '', s: ESTILO_PENDIENTE }
      : { t: 's', v: texto, s: ESTILO_ENC_VALOR };
    if (pendiente) {
      camposPendientes.push(String(campo.etiqueta));
      // el amarillo tiene que cubrir TODA la celda combinada
      for (let c = 2; c <= ultimaColumna; c++) {
        ws[XLSX.utils.encode_cell({ r, c })] = { t: 's', v: '', s: ESTILO_PENDIENTE };
      }
    }
    if (ultimaColumna > 1) {
      ws['!merges'].push({ s: { r, c: 1 }, e: { r, c: ultimaColumna } });
    }
  });

  // Encabezados
  columnas.forEach((col, j) => {
    ws[XLSX.utils.encode_cell({ r: FILA_ENCABEZADO, c: j })] = { t: 's', v: col, s: ESTILO_ENCABEZADO };
  });

  // Registros (desde la fila 2)
  filasCalculadas.forEach((fila, i) => {
    const filaExcel = PRIMERA_FILA_DATOS + i + 1; // fila real en Excel (base 1)
    claves.forEach((clave, j) => {
      const valor = fila[clave];
      const ref = XLSX.utils.encode_cell({ r: PRIMERA_FILA_DATOS + i, c: j });
      const tieneRegla = reglas && Object.prototype.hasOwnProperty.call(reglas, clave);

      if (tieneRegla) {
        const traducida = traducirFormula(reglas[clave], letras, filaExcel);
        if (traducida && typeof valor === 'number') {
          ws[ref] = { t: 'n', v: valor, f: `ROUND(${traducida},2)` };
          return;
        }
        columnasSinFormula.add(columnas[j]);
      }

      if (valor === undefined || valor === null || valor === '') return;
      ws[ref] = typeof valor === 'number'
        ? { t: 'n', v: valor, ...(j === 0 && encabezadoDoc.length > 0 ? { s: ESTILO_INDICE_CENTRADO } : {}) }
        : { t: 's', v: String(valor) };
    });
  });

  // Fila de Totales: SUM real de cada columna numérica (todas las
  // filas tienen que ser número ahí — igual de estricto que
  // detectorFormulas.js). La primera columna dice "Total" en vez de
  // sumarse. Es una fórmula real, no un número fijo: si el usuario
  // edita una fila en Excel, el total se recalcula solo.
  // Si el documento trae PIE (factura), esta fila NO se agrega: sumaría
  // también Cant. y P. Unitario, que en una factura no tiene sentido, y
  // el pie ya trae su propio Subtotal/Total.
  let filaTotalExcel = null;
  if (incluirTotales && !hayPie && filasCalculadas.length > 0) {
    const primeraFilaDatosExcel = PRIMERA_FILA_DATOS + 1;
    const ultimaFilaDatosExcel = PRIMERA_FILA_DATOS + filasCalculadas.length;
    filaTotalExcel = PRIMERA_FILA_DATOS + filasCalculadas.length;

    claves.forEach((clave, j) => {
      const ref = XLSX.utils.encode_cell({ r: filaTotalExcel, c: j });
      if (j === 0) {
        ws[ref] = { t: 's', v: 'Total', s: ESTILO_TOTAL };
        return;
      }
      const todasNumericas = filasCalculadas.every(f => typeof f[clave] === 'number' && Number.isFinite(f[clave]));
      if (!todasNumericas) {
        ws[ref] = { t: 's', v: '', s: ESTILO_TOTAL };
        return;
      }
      const letra = letras[clave];
      const rango = `${letra}${primeraFilaDatosExcel}:${letra}${ultimaFilaDatosExcel}`;
      const suma = Math.round(filasCalculadas.reduce((acc, f) => acc + f[clave], 0) * 100) / 100;
      ws[ref] = { t: 'n', v: suma, f: `SUM(${rango})`, s: ESTILO_TOTAL };
    });
  }

  // PIE de cálculos (Subtotal → ITBMS → Total a pagar), justo debajo de
  // la tabla. Cada valor es una fórmula REAL de Excel cuando
  // tablaExtendida.js la verificó contra la foto: "resumen_suma_total"
  // se traduce a SUM(E10:E13), y las filas anteriores del pie a su
  // celda (ej. subtotal → E14). Sin fórmula validada, va el valor fijo
  // de la foto; sin valor legible, una celda amarilla vacía.
  let filaPieUltima = null;
  if (hayPie) {
    // Recalculado con las líneas actuales: así el valor en caché de cada
    // fórmula siempre coincide con lo que Excel va a calcular.
    const pieCalculado = recalcularPie(pieDoc, claves, filasCalculadas);
    const primeraFilaDatosExcel = PRIMERA_FILA_DATOS + 1;
    const ultimaFilaDatosExcel = PRIMERA_FILA_DATOS + filasCalculadas.length;

    const referencias = {};
    for (const clave of claves) {
      if (!clave) continue; // p. ej. la columna "#"
      const l = letras[clave];
      referencias[`resumen_suma_${clave}`] = `SUM(${l}${primeraFilaDatosExcel}:${l}${ultimaFilaDatosExcel})`;
    }

    const colValor = ultimaColumna;
    const colEtiqueta = ultimaColumna - 1;
    const letraValor = XLSX.utils.encode_col(colValor);
    const primeraFilaPie = PRIMERA_FILA_DATOS + filasCalculadas.length;

    pieCalculado.forEach((fila, i) => {
      const filaHoja = primeraFilaPie + i;
      const filaExcel = filaHoja + 1;
      const esUltima = i === pieCalculado.length - 1;
      const estiloEtiqueta = esUltima ? ESTILO_PIE_FINAL_ETIQUETA : ESTILO_PIE_ETIQUETA;
      const estiloValor = esUltima ? ESTILO_PIE_FINAL_VALOR : ESTILO_PIE_VALOR;
      const refValor = XLSX.utils.encode_cell({ r: filaHoja, c: colValor });

      ws[XLSX.utils.encode_cell({ r: filaHoja, c: colEtiqueta })] = { t: 's', v: String(fila.etiqueta), s: estiloEtiqueta };

      if (fila.pendiente || fila.valor === null || fila.valor === undefined) {
        ws[refValor] = { t: 's', v: '', s: ESTILO_PENDIENTE };
        camposPendientes.push(String(fila.etiqueta));
        return;
      }

      if (fila.formula) {
        const traducida = traducirFormulaSecciones(fila.formula, referencias);
        if (traducida && typeof fila.valor === 'number') {
          ws[refValor] = { t: 'n', v: fila.valor, f: `ROUND(${traducida},2)`, z: FORMATO_DINERO, s: estiloValor };
        } else {
          // No debería pasar (la fórmula ya viene validada); si por algo no
          // se puede traducir, valor fijo y se avisa — nunca una fórmula dudosa.
          ws[refValor] = typeof fila.valor === 'number'
            ? { t: 'n', v: fila.valor, z: FORMATO_DINERO, s: estiloValor }
            : { t: 's', v: String(fila.valor), s: estiloValor };
          pieSinFormula.push(String(fila.etiqueta));
        }
      } else {
        ws[refValor] = typeof fila.valor === 'number'
          ? { t: 'n', v: fila.valor, z: FORMATO_DINERO, s: estiloValor }
          : { t: 's', v: String(fila.valor), s: estiloValor };
        // Solo se avisa si Groq SÍ sugirió una fórmula y no cuadró — un dato
        // crudo (ej. un descuento) no es una fórmula "faltante".
        if (fila.formulaOriginal) pieSinFormula.push(String(fila.etiqueta));
      }

      // Disponible para las filas SIGUIENTES del pie
      if (typeof fila.valor === 'number') referencias[fila.clave] = `${letraValor}${filaExcel}`;
    });
    filaPieUltima = primeraFilaPie + pieCalculado.length - 1;
  }

  const ultimaFilaHoja = filaPieUltima !== null
    ? filaPieUltima
    : filaTotalExcel !== null
      ? filaTotalExcel
      : PRIMERA_FILA_DATOS + Math.max(filasCalculadas.length - 1, 0);

  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: ultimaFilaHoja, c: ultimaColumna },
  });

  // Alturas: título y encabezado un poco más altos
  ws['!rows'] = [];
  ws['!rows'][FILA_TITULO] = { hpt: 28 };
  ws['!rows'][FILA_ENCABEZADO] = { hpt: 20 };

  // Ancho de cada columna según su texto más largo
  ws['!cols'] = columnas.map((col, j) => {
    const largo = Math.max(
      col.length,
      ...filasCalculadas.map(f => String(f[claves[j]] ?? '').length)
    );
    return { wch: Math.min(40, Math.max(10, largo + 2)) };
  });
  // La 1ª columna también lleva las etiquetas del encabezado del
  // documento ("Fecha de vencimiento"...) — que no queden cortadas.
  if (encabezadoDoc.length > 0 && ws['!cols'][0]) {
    const etiquetaLarga = Math.max(...encabezadoDoc.map(c => String(c.etiqueta).length));
    ws['!cols'][0].wch = Math.max(ws['!cols'][0].wch, Math.min(26, etiquetaLarga + 2));
  }
  // Con encabezado/pie en una tabla de 1 sola columna, la 2ª también necesita ancho
  while (ws['!cols'].length <= ultimaColumna) ws['!cols'].push({ wch: 16 });

  // Tabla ancha: con los márgenes normales la última columna se imprime en una
  // 2ª página. Si no cabe, se angostan los márgenes laterales. (Las tablas que ya
  // caben no se tocan: su archivo sale idéntico al de antes.)
  const anchoPx = ws['!cols'].reduce((acc, c) => acc + Math.round((c.wch || 10) * 7 + 5), 0);
  if (anchoPx > 660) {
    ws['!margins'] = { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 };
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, nombreHoja(nombreCuadro));

  const salida = XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true });

  return {
    bytes: new Uint8Array(salida),
    nombreArchivo: nombreArchivo(nombreCuadro),
    mime: MIME_XLSX,
    columnasSinFormula: [...columnasSinFormula],
    camposPendientes,
    pieSinFormula,
  };
}