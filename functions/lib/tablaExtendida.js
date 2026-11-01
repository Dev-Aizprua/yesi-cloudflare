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

// ── Datos del encabezado que MÁS se leen mal en una foto (fecha, teléfono, RUC, D.V.) ─────────────
// Los montos los suma y verifica el código; estos datos son texto y nada los verifica. Por eso:
//   - un teléfono de dígitos repetidos (0000-0000, 5555-5555) es relleno o una lectura inventada → queda PENDIENTE;
//   - una fecha de emisión futura o de hace más de un año se MUESTRA pero con aviso (puede ser un año mal leído);
//   - RUC, D.V. y teléfono siempre llevan un "revísalos contra tu factura" antes del "sí".
const sinTildes = x => String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const claveEtiqueta = e => sinTildes(e).replace(/[^a-z0-9]+/g, ' ').trim().replace(/\br u c\b/, 'ruc');
const esEtiquetaTelefono = e => /\b(telefono|tel|tlf|celular|cel)\b/.test(claveEtiqueta(e));
const esEtiquetaRuc = e => /\bruc\b/.test(claveEtiqueta(e));
const esEtiquetaDv = e => /\b(dv|d v|digito verificador)\b/.test(claveEtiqueta(e));
const esEtiquetaFechaEmision = e => { const c = claveEtiqueta(e); return c.startsWith('fecha') && !c.includes('venc'); };

function telefonoRelleno(texto) {
  const digitos = String(texto ?? '').replace(/\D/g, '');
  return digitos.length >= 6 && /^(\d)\1+$/.test(digitos);
}

// Fecha escrita como día/mes/año (formato de Panamá) o AAAA-MM-DD. null si no se reconoce ninguna.
function leerFechaFactura(texto) {
  const s = String(texto ?? '');
  let d, mo, y;
  let m = s.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})\b/);
  if (m) { d = Number(m[1]); mo = Number(m[2]); y = Number(m[3]); if (m[3].length === 2) y += 2000; }
  else {
    m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (!m) return null;
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
  }
  const f = new Date(Date.UTC(y, mo - 1, d));
  const existe = f.getUTCFullYear() === y && f.getUTCMonth() === mo - 1 && f.getUTCDate() === d;
  const dos = n => String(n).padStart(2, '0');
  return { existe, ms: f.getTime(), texto: `${dos(d)}/${dos(mo)}/${y}` };
}

/**
 * Avisos de REVISIÓN del encabezado leído de una foto (se recalculan cada vez que se muestra la vista previa,
 * así que si el usuario corrige la fecha, el aviso de la fecha desaparece solo).
 * @param {Array} encabezado  el que devolvió validarEncabezado
 * @param {Date} [ahora]
 * @returns {string[]}
 */
export function avisosRevisionEncabezado(encabezado, ahora = new Date()) {
  const lista = Array.isArray(encabezado) ? encabezado : [];
  const avisos = [];
  const p = new Date(ahora.getTime() - 5 * 3600 * 1000); // hora de Panamá (UTC-5)
  const hoy = Date.UTC(p.getUTCFullYear(), p.getUTCMonth(), p.getUTCDate());
  const DIA = 86400000;
  for (const c of lista) {
    if (c?.valor === null || c?.valor === undefined || !esEtiquetaFechaEmision(c.etiqueta)) continue;
    const f = leerFechaFactura(c.valor);
    if (!f) continue;
    if (!f.existe) avisos.push(`${c.etiqueta}: "${c.valor}" no es una fecha que exista — revísala y dime la correcta.`);
    else if (f.ms > hoy + DIA) avisos.push(`${c.etiqueta}: leí ${f.texto}, que es una fecha futura — ¿se leyó mal? Dime la correcta.`);
    else if (f.ms < hoy - 365 * DIA) avisos.push(`${c.etiqueta}: leí ${f.texto}, de hace más de un año — ¿se leyó mal? Dime la correcta.`);
  }
  const identificacion = lista
    .filter(c => c?.valor !== null && c?.valor !== undefined && (esEtiquetaRuc(c.etiqueta) || esEtiquetaDv(c.etiqueta) || esEtiquetaTelefono(c.etiqueta)))
    .map(c => c.etiqueta);
  if (identificacion.length > 0) avisos.push(`Revisa contra tu factura: ${identificacion.join(', ')} (son los datos que más se leen mal en una foto).`);
  return avisos;
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
      let texto = c?.valor === null || c?.valor === undefined ? '' : String(c.valor).trim();
      if (texto !== '' && esEtiquetaTelefono(etiqueta) && telefonoRelleno(texto)) texto = ''; // 0000-0000 / 5555-5555: relleno o lectura inventada
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