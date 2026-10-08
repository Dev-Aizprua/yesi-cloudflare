// functions/lib/tablaExtendida.js
// ENCABEZADO y PIE de una tabla — pensado para facturas, pero genérico:
//   - ENCABEZADO: pares etiqueta/valor que van ANTES de la tabla (negocio,
//     RUC, cliente, fecha, número de factura...). Son texto, no hay cuenta
//     que los verifique, así que si un dato no se lee con seguridad
//     (valor null o vacío) NO se inventa: queda "pendiente", vacío y
//     marcado, para que el usuario lo complete después (decisión de
//     alcance ya acordada: avisar, nunca bloquear).
//   - PIE: una cadena de filas calculadas DESPUÉS de la tabla, donde cada
//     una puede depender de la suma de una columna o de la fila de pie
//     anterior (Subtotal → ITBMS → Total). Mismo principio de siempre:
//     Groq SUGIERE la fórmula como texto, el código la VERIFICA contra el
//     número que la foto ya muestra, y solo se acepta si cuadra.
//
// REUSO: la verificación del pie NO es un motor nuevo. Es exactamente
// validarReporteSecciones() (ya probado en producción con Pago de
// Quincena), tratando:
//   - las SUMAS DE COLUMNA como "estadísticas de resumen" → clave
//     "resumen_suma_<clave de la columna>", ej. columna Total →
//     resumen_suma_total;
//   - el PIE como una sección cuyas filas se encadenan → cada fila puede
//     usar las anteriores, con su clave sin prefijo (subtotal, itbms_7).
// Por eso una fórmula del pie nunca puede referirse a algo que no esté
// definido más arriba, y una variable inventada se descarta sin romper.

import { Parser } from 'expr-eval';
import { validarReporteSecciones } from './reporteSecciones.js';

const parser = new Parser();

function esNumero(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function redondear2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Suma de cada columna cuyas filas son TODAS números (igual de
 * estricto que la fila de Totales de imagenCuadro.js/excelCuadro.js:
 * mejor omitir una columna dudosa que sumar mal).
 *
 * @returns {Array<{clave: string, valor: number}>}
 */
export function sumasDeColumnas(columnasInternas, filas) {
  if (!filas || filas.length === 0) return [];
  const sumas = [];
  for (const clave of columnasInternas) {
    if (!clave) continue; // p. ej. la columna "#", que normaliza a clave vacía
    if (!filas.every(f => esNumero(f[clave]))) continue;
    sumas.push({ clave, valor: redondear2(filas.reduce((acc, f) => acc + f[clave], 0)) });
  }
  return sumas;
}

// validarReporteSecciones arma la clave como "resumen_" + la etiqueta
// normalizada, y esa normalización BORRA los guiones bajos. Por eso la
// etiqueta se arma con espacios ("suma p unitario" → resumen_suma_p_unitario).
function etiquetaDeSuma(clave) {
  return `suma ${clave.replace(/_/g, ' ')}`;
}

/**
 * @param {Array<{etiqueta: string, valor: any, formula_sugerida?: string}>} pieCrudo
 *   lo que transcribió Groq, en el orden de la foto
 * @param {string[]} columnasInternas
 * @param {Object[]} filas  las líneas de la tabla (sin fila de Totales)
 * @returns {{ pie: Array, alertas: string[] }}
 *   pie: cada fila con { etiqueta, clave, valor, formula, formulaOriginal };
 *   `formula` es null si no se pudo verificar (el valor queda fijo).
 *   alertas: avisos para el usuario — SOLO las filas donde Groq sí sugirió
 *   una fórmula y no cuadró con la foto (una fila que nunca tuvo fórmula
 *   es un dato crudo, no un aviso).
 */
export function validarPie(pieCrudo, columnasInternas, filas) {
  const estadisticas = sumasDeColumnas(columnasInternas, filas)
    .map(s => ({ etiqueta: etiquetaDeSuma(s.clave), valor: s.valor }));

  // Una fila cuyo valor no se pudo leer (null/vacío) NO se convierte en
  // 0 — eso sería inventar un número. Se manda al motor con un texto
  // marcador: el motor solo usa números para validar y para el
  // contexto, así que esa fila ni se valida ni se ofrece a las
  // siguientes. Al terminar se deja pendiente: valor null, sin fórmula.
  const PENDIENTE = '__pendiente__';
  const sinValor = v => v === null || v === undefined || String(v).trim() === '';
  const filasParaMotor = (pieCrudo || []).map(f => (sinValor(f?.valor) ? { ...f, valor: PENDIENTE } : f));

  const validado = validarReporteSecciones({
    titulo: 'pie',
    estadisticas,
    secciones: [{ nombre: 'PIE', filas: filasParaMotor }],
  });

  const pie = validado.secciones[0].filas.map(f =>
    f.valor === PENDIENTE
      ? { ...f, valor: null, formula: null, pendiente: true }
      : { ...f, pendiente: false }
  );

  const alertas = [];
  for (const f of pie) {
    if (f.pendiente) {
      alertas.push(`${f.etiqueta} no identificado con seguridad — quedará vacío.`);
    } else if (f.formulaOriginal && !f.formula) {
      alertas.push(`${f.etiqueta}: no pude confirmar que se calcule como "${f.formulaOriginal}" con los números de la foto — queda con el valor que dice la foto (${f.valor}), sin fórmula.`);
    }
  }

  return { pie, alertas };
}

/**
 * Recalcula el pie con las líneas actuales — se llama cuando el usuario
 * cambia, agrega o elimina una línea, para que Subtotal/ITBMS/Total se
 * actualicen solos. Las filas del pie SIN fórmula validada se dejan
 * exactamente como estaban (valor fijo).
 */
export function recalcularPie(pie, columnasInternas, filas) {
  const contexto = {};
  for (const s of sumasDeColumnas(columnasInternas, filas)) {
    contexto[`resumen_suma_${s.clave}`] = s.valor;
  }

  return (pie || []).map(fila => {
    let valor = fila.valor;
    if (fila.formula) {
      try {
        const r = parser.parse(fila.formula).evaluate(contexto);
        if (esNumero(r)) valor = redondear2(r);
      } catch (e) {
        // fórmula que ya no evalúa: se conserva el valor anterior, no se rompe nada
      }
    }
    if (esNumero(valor)) contexto[fila.clave] = valor;
    return { ...fila, valor };
  });
}

/**
 * Limpia el encabezado tal como lo transcribió Groq. Un valor null,
 * vacío o solo espacios queda PENDIENTE: no se inventa nada.
 *
 * @param {Array<{etiqueta: string, valor: any}>} encabezadoCrudo
 * @returns {Array<{etiqueta: string, valor: string|null, pendiente: boolean}>}
 */
export function validarEncabezado(encabezadoCrudo) {
  return (Array.isArray(encabezadoCrudo) ? encabezadoCrudo : [])
    .map(c => {
      const etiqueta = String(c?.etiqueta ?? '').trim().replace(/:\s*$/, '');
      const texto = c?.valor === null || c?.valor === undefined ? '' : String(c.valor).trim();
      return { etiqueta, valor: texto === '' ? null : texto, pendiente: texto === '' };
    })
    .filter(c => c.etiqueta);
}

/** Avisos para el usuario, uno por cada campo del encabezado que quedó pendiente. */
export function avisosEncabezado(encabezado) {
  return (encabezado || [])
    .filter(c => c.pendiente)
    .map(c => `${c.etiqueta} no identificado con seguridad — quedará vacío.`);
}