// functions/lib/reporteSecciones.js
// Motor de validación para el reporte tipo "secciones" (ej. Pago de
// Quincena): una estadística de resumen suelta arriba, y una o más
// secciones con nombre, cada una con sus propias filas de etiqueta/valor.
//
// A diferencia de detectorFormulas.js (tabla uniforme, con varias filas
// para comparar un patrón), aquí cada sección es UN SOLO registro — no
// hay patrón que buscar. Por eso NO se intenta adivinar ninguna fórmula:
// Groq la SUGIERE como texto usando las claves internas ya calculadas
// (ej. "resumen_capital - capital"), y este archivo la VERIFICA
// aritméticamente contra el valor real que ya trae la foto, antes de
// aceptarla. "Groq propone, el código dispone" — igual que ya se hace
// con crear_cuadro por voz.
//
// ESCOPE DE CLAVES (evita la ambigüedad de que "Capital" pueda referirse
// a la estadística de resumen o a una fila de la sección, que son dos
// números distintos en el documento real):
//   - Estadística de resumen (fuera de cualquier sección):
//       "resumen_" + etiqueta normalizada, ej. "resumen_capital"
//   - Fila dentro de una sección: etiqueta normalizada SIN prefijo,
//       ej. "capital" (dentro de esa sección nada más)
// Una fórmula sugerida solo puede usar: las estadísticas de resumen, o
// filas ANTERIORES de la MISMA sección — nunca una fila de otra sección
// ni una fila posterior de la suya. El prompt de visión (visionCuadro.js)
// es responsable de darle a Groq justo esas claves disponibles al pedir
// la fórmula, así que aquí no se hace sustitución de texto por nombre de
// columna — solo se verifica que cada identificador de la fórmula
// coincida con una clave conocida (sin importar mayúsculas/tildes), y si
// no coincide con ninguna, se descarta sin arriesgar.

import { Parser } from 'expr-eval';

const TOLERANCIA = 0.03;

function normalizarClave(texto) {
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '') // quita paréntesis, %, etc.
    .trim()
    .replace(/\s+/g, '_');
}

// Convierte un valor tal como lo transcribió Groq (texto "11,142.00",
// número, o vacío) al tipo que usa calculo.js: número si se puede, texto
// si no, 0 si viene vacío/nulo — mismo criterio que parsearValorFoto en
// whatsapp.js, para que un reporte de secciones se comporte igual que
// uno de tabla uniforme frente a datos sucios de la foto.
function parsearValor(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const texto = String(v).trim();
  if (texto === '') return 0;
  const limpio = texto.replace(/[$,\s]/g, '');
  if (/^-?\d+(\.\d+)?$/.test(limpio)) return Number(limpio);
  return texto;
}

// Tokenizador de la fórmula (mismo patrón que traducirFormula en
// excelCuadro.js): recorre número por número, identificador por
// identificador, operador por operador. Cada identificador se busca
// entre las claves YA DISPONIBLES en este punto (resumen + filas
// anteriores de la misma sección), comparando de forma insensible a
// mayúsculas/tildes. Si un identificador no coincide con ninguna clave
// conocida, la fórmula se descarta entera — nunca se arriesga a adivinar
// a qué se refería.
const TOKEN_RE = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_$][A-Za-z0-9_$]*)|([+\-*/^(),]))/y;

function normalizarIdentificadores(formula, clavesDisponibles) {
  const porNormalizada = {};
  for (const clave of clavesDisponibles) porNormalizada[normalizarClave(clave)] = clave;

  let salida = '';
  let pos = 0;
  const texto = String(formula).trim();

  while (pos < texto.length) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(texto);
    if (!m) return null; // carácter no soportado
    pos = TOKEN_RE.lastIndex;

    if (m[1] !== undefined) {
      salida += m[1];
    } else if (m[2] !== undefined) {
      const claveReal = porNormalizada[normalizarClave(m[2])];
      if (!claveReal) return null; // identificador desconocido — no se arriesga
      salida += claveReal;
    } else {
      salida += m[3];
    }
  }
  return salida.length ? salida : null;
}

// Evalúa la fórmula sugerida contra el contexto disponible en este punto
// (resumen + filas anteriores de la sección) y la acepta SOLO si el
// resultado coincide, dentro de la tolerancia, con el valor real que la
// foto ya muestra para esta fila.
function validarFormulaContraValor(formulaSugerida, contexto, valorReal) {
  if (!formulaSugerida || typeof valorReal !== 'number') return null;

  const normalizada = normalizarIdentificadores(formulaSugerida, Object.keys(contexto));
  if (!normalizada) return null;

  let expr;
  try {
    expr = Parser.parse(normalizada);
  } catch (e) {
    return null; // fórmula mal formada
  }

  let resultado;
  try {
    resultado = expr.evaluate(contexto);
  } catch (e) {
    return null; // ej. referencia a algo que no evalúa (no debería pasar tras normalizar, pero no se arriesga)
  }

  if (typeof resultado !== 'number' || !Number.isFinite(resultado)) return null;
  if (Math.abs(resultado - valorReal) > TOLERANCIA) return null;

  return normalizada; // se guarda ya normalizada (mismas claves que usa calculo.js), lista para traducir a Excel
}

/**
 * Valida un reporte tipo "secciones" recién transcrito por Groq.
 *
 * @param {Object} extraido
 * @param {string} extraido.titulo
 * @param {string} [extraido.subtitulo]
 * @param {Array<{etiqueta: string, valor: any}>} extraido.estadisticas
 * @param {Array<{nombre: string, filas: Array<{etiqueta: string, valor: any, formula_sugerida?: string}>}>} extraido.secciones
 *
 * @returns {Object} misma forma, con cada fila ya con su `clave` interna,
 *   `valor` tipado, y `formula` (string normalizada) o `null` si no se
 *   pudo validar contra el valor real — en cuyo caso el valor queda fijo.
 *   También incluye `formulaOriginal`: el texto que sugirió Groq tal
 *   cual, o `null` si nunca sugirió ninguna. Sirve para distinguir "esta
 *   fila nunca tuvo fórmula" (valor crudo de la foto) de "se sugirió una
 *   fórmula pero se rechazó por no cuadrar" — mismo tipo de aviso que ya
 *   se le da al usuario con columnasSinFormula en excelCuadro.js.
 */
export function validarReporteSecciones(extraido) {
  const estadisticas = (extraido.estadisticas || []).map(e => ({
    etiqueta: e.etiqueta,
    clave: `resumen_${normalizarClave(e.etiqueta)}`,
    valor: parsearValor(e.valor),
  }));

  const contextoResumen = {};
  for (const e of estadisticas) {
    if (typeof e.valor === 'number') contextoResumen[e.clave] = e.valor;
  }

  const secciones = (extraido.secciones || []).map(seccion => {
    // Cada sección arranca su propio contexto con las estadísticas de
    // resumen — nunca hereda filas de otra sección.
    const contextoSeccion = { ...contextoResumen };
    const filas = [];

    for (const filaCruda of (seccion.filas || [])) {
      const clave = normalizarClave(filaCruda.etiqueta);
      const valor = parsearValor(filaCruda.valor);
      const formula = validarFormulaContraValor(filaCruda.formula_sugerida, contextoSeccion, valor);

      filas.push({
        etiqueta: filaCruda.etiqueta,
        clave,
        valor,
        formula,
        formulaOriginal: filaCruda.formula_sugerida || null,
      });

      // Disponible para las filas SIGUIENTES de esta misma sección — se
      // agrega DESPUÉS de validar, para que una fórmula nunca pueda
      // referirse a sí misma ni a una fila que todavía no existía en la foto.
      if (typeof valor === 'number') contextoSeccion[clave] = valor;
    }

    return { nombre: seccion.nombre, filas };
  });

  return {
    titulo: extraido.titulo || 'Reporte',
    subtitulo: extraido.subtitulo || null,
    estadisticas,
    secciones,
  };
}