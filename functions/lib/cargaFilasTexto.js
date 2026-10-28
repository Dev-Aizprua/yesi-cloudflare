// functions/lib/cargaFilasTexto.js
// Cargar VARIOS registros a un cuadro desde un mensaje de texto o voz ("Carlos 460, Susan 300, Yisel 200").
//
// Reparto de trabajo (mismo principio de todo el proyecto):
//   - Groq SOLO lee el mensaje y separa: quién es cada registro y qué valores dijo, tal cual (extraerFilasDeTexto).
//   - El CÓDIGO decide todo lo demás (armarFilasNuevas): a qué columna va cada valor, calcula las fórmulas del
//     cuadro, detecta nombres repetidos, marca lo que no encaja y lo que contradice una fórmula.
//   - Nada se guarda hasta que el usuario dice "sí" (vista previa + confirmación, en whatsapp.js).
// Este archivo es de funciones puras (más la llamada a Groq con el fetch inyectado) para poder probarlo solo.

import { calcularFila } from './calculo.js';
import { buscarFila } from './buscarFila.js';

export const MAX_FILAS_CARGA = 40;

const sinTildes = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ── Valores ─────────────────────────────────────────────────────────────────────────────────────────

/** Clasifica un valor tal como lo dijo el usuario: número, porcentaje (nunca se guarda como monto), texto o vacío. */
export function parsearValorCarga(v) {
  if (v === null || v === undefined) return { tipo: 'vacio' };
  if (typeof v === 'number') return Number.isFinite(v) ? { tipo: 'numero', valor: v } : { tipo: 'vacio' };
  const t = String(v).trim();
  if (t === '') return { tipo: 'vacio' };
  if (t.includes('%')) return { tipo: 'porcentaje', texto: t };
  const limpio = t.replace(/B\/\.?/gi, '').replace(/[$\s]/g, '').replace(/,(?=\d{3}(\D|$))/g, '');
  if (/^-?\d+(\.\d+)?$/.test(limpio)) return { tipo: 'numero', valor: Number(limpio) };
  return { tipo: 'texto', texto: t };
}

const esNumero = v => typeof v === 'number' && Number.isFinite(v);

/**
 * Columnas "de números" de un cuadro existente: las que tienen fórmula, o donde todos los valores
 * que hay son números. Sirve para completar con 0 lo que el usuario no dijo (así la fila de Totales
 * no se rompe por una celda vacía) y para rechazar texto en una columna de montos.
 */
export function columnasNumericasDe(internas, filas, reglas, claveNombre) {
  const set = new Set();
  for (const c of internas) {
    if (c === claveNombre) continue;
    if (reglas && reglas[c]) { set.add(c); continue; }
    const valores = (filas || []).map(f => f?.[c]).filter(v => v !== undefined && v !== null && v !== '');
    if (valores.length > 0 && valores.every(esNumero)) set.add(c);
  }
  return set;
}

const nombreDeFila = (f, claveNombre) => String(f?.[claveNombre] ?? f?.nombre ?? '').trim();

// ── Armado de las filas nuevas ──────────────────────────────────────────────────────────────────────

/** ¿La primera columna es una fecha? ("fecha", "día"): repetirla es normal, no se tratan como "mismo nombre". */
export function primeraColumnaEsFecha(claveNombre, nombreBonito = '') {
  return /^(fecha|dia|date)\b/.test(String(claveNombre).replace(/_/g, ' ')) || /^\s*fecha\b/i.test(String(nombreBonito));
}

/**
 * Convierte lo que extrajo Groq en filas listas para el cuadro. NUNCA inventa ni calcula por su cuenta:
 * solo coloca valores dichos en columnas que existen y aplica las fórmulas del cuadro.
 *
 * @param {object} p
 *   extraidas        [{ nombre, valores: {clave: valor}, otros: [texto] }]  (lo que devolvió Groq)
 *   columnasBonitas  nombres de columna tal como se muestran
 *   columnasInternas sus claves (la primera es la del nombre)
 *   reglas           fórmulas del cuadro { clave: "monto * 0.1" }
 *   filasExistentes  filas que ya tiene el cuadro (para detectar nombres repetidos)
 *   columnasNumericas Set de claves numéricas, o null si no se conoce (cuadro nuevo)
 *   normalizarClave  función de whatsapp.js (misma que usa todo el sistema)
 * @returns {{ filas: object[], avisos: string[], sinAsignar: {nombre:string,texto:string}[], omitidas: string[], numericas: Set<string> }}
 */
export function armarFilasNuevas({ extraidas, columnasBonitas, columnasInternas, reglas = {}, filasExistentes = [], columnasNumericas = null, normalizarClave }) {
  const claveNombre = columnasInternas[0];
  const bonita = c => columnasBonitas[columnasInternas.indexOf(c)] || c;
  const avisos = [];
  const sinAsignar = [];
  const omitidas = [];

  // Si la primera columna es una fecha (cuadro de gastos, ventas...), repetirla es normal: no se detectan "nombres repetidos".
  const primeraEsFecha = primeraColumnaEsFecha(claveNombre, bonita(claveNombre));
  const existentes = primeraEsFecha ? [] : (filasExistentes || []).map(f => ({ nombre: nombreDeFila(f, claveNombre) }));
  const vistosEnMensaje = new Set();
  const crudas = [];

  for (const e of extraidas || []) {
    const nombre = String(e?.nombre ?? '').trim();
    if (!nombre) { omitidas.push('un registro sin nombre'); continue; }

    const clave = normalizarClave(nombre);
    if (!primeraEsFecha && vistosEnMensaje.has(clave)) {
      omitidas.push(`${nombre} (aparece dos veces en tu mensaje; dejé solo el primero)`);
      continue;
    }
    const previa = buscarFila(nombre, existentes);
    if (previa.tipo === 'exacto') {
      omitidas.push(`${nombre} (ya está en el cuadro; para cambiarlo dime "actualiza a ${nombre}...")`);
      continue;
    }
    if (previa.tipo === 'alto' || previa.tipo === 'ambiguo') {
      const parecidos = (previa.candidatos || []).map(c => c.nombre).filter(Boolean).join(' o ');
      if (parecidos) avisos.push(`"${nombre}" se parece a ${parecidos}, que ya está en el cuadro. Si es la misma persona, dime "quita a ${nombre}".`);
    }
    vistosEnMensaje.add(clave);

    const fila = { [claveNombre]: nombre };
    if (claveNombre !== 'nombre') fila.nombre = nombre; // buscarFila lee siempre "nombre"
    const dados = {}; // valores dichos para columnas que tienen fórmula (se comparan con el resultado)

    for (const [k, v] of Object.entries(e?.valores || {})) {
      const col = normalizarClave(k);
      if (col === claveNombre) continue; // el nombre ya va aparte; repetirlo no es un dato suelto
      if (!columnasInternas.includes(col)) {
        sinAsignar.push({ nombre, texto: `${k}: ${v}` });
        continue;
      }
      const pv = parsearValorCarga(v);
      if (pv.tipo === 'vacio') continue;
      if (pv.tipo === 'porcentaje' && reglas[col] && formulaUsaPorcentaje(reglas[col], pv.texto)) continue; // la fórmula ya lo aplica
      if (pv.tipo === 'porcentaje') {
        sinAsignar.push({ nombre, texto: `${bonita(col)}: ${pv.texto} (es un porcentaje, no un monto)` });
        continue;
      }
      if (pv.tipo === 'texto' && columnasNumericas && columnasNumericas.has(col)) {
        sinAsignar.push({ nombre, texto: `${bonita(col)}: "${pv.texto}" (esa columna es de números)` });
        continue;
      }
      const valor = pv.tipo === 'numero' ? pv.valor : pv.texto;
      if (reglas[col]) dados[col] = valor;
      else fila[col] = valor;
    }
    for (const o of e?.otros || []) {
      const t = String(o ?? '').trim();
      if (t) sinAsignar.push({ nombre, texto: t });
    }
    crudas.push({ fila, dados });
  }

  // Nombres sin ningún dato (típico de una nota de voz mal entendida): se avisa antes de guardar en 0.
  const sinDatos = crudas.filter(x => Object.keys(x.fila).every(k => k === claveNombre || k === 'nombre') && Object.keys(x.dados).length === 0)
    .map(x => x.fila[claveNombre]);
  if (sinDatos.length > 0) {
    avisos.push(`${sinDatos.join(', ')}: sin ningún monto (quedarían en 0). Si no era eso, responde "no".`);
  }
  // Columnas de números: las conocidas, o (cuadro nuevo) las que solo recibieron números.
  let numericas = columnasNumericas ? new Set(columnasNumericas) : new Set();
  if (!columnasNumericas) {
    for (const c of columnasInternas) {
      if (c === claveNombre) continue;
      const valores = crudas.map(x => x.fila[c]).filter(v => v !== undefined);
      if (reglas[c] || (valores.length > 0 && valores.every(esNumero))) numericas.add(c);
    }
  }

  const filas = [];
  for (const { fila, dados } of crudas) {
    for (const c of numericas) if (!reglas[c] && fila[c] === undefined) fila[c] = 0;
    const calculada = calcularFila(fila, reglas);
    const nombre = calculada[claveNombre];
    for (const [c, dado] of Object.entries(dados)) {
      const resultado = calculada[c];
      if (esNumero(dado) && esNumero(resultado) && Math.abs(dado - resultado) > 0.01) {
        avisos.push(`${nombre}: dijiste ${bonita(c)} ${dado}, pero por la fórmula del cuadro da ${resultado}; dejé ${resultado}. Si querías decir otra cosa (ej. un abono), corrígelo abajo.`);
      }
    }
    if (calculada._error_calculo) {
      avisos.push(`${nombre}: no pude calcular ${calculada._error_calculo}`);
      delete calculada._error_calculo;
    }
    filas.push(calculada);
  }
  return { filas, avisos, sinAsignar, omitidas, numericas };
}

// ¿La fórmula ya aplica ese porcentaje? ("10%" y monto*0.10 → sí). Compara el número/100 con los números de la fórmula.
function formulaUsaPorcentaje(formula, textoPct) {
  const n = parseFloat(String(textoPct).replace(',', '.').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return false;
  const tasa = n / 100;
  const nums = String(formula).match(/\d+(?:\.\d+)?/g) || [];
  return nums.some(x => Math.abs(parseFloat(x) - tasa) < 1e-9);
}

// ── Lectura con Groq (llamada pequeña y aparte) ─────────────────────────────────────────────────────

export function construirPromptExtraccion(texto, columnasBonitas, columnasInternas, reglas = {}) {
  const lista = columnasInternas.map((c, i) => {
    const calculada = reglas[c] ? ' — se calcula sola; solo ponla si el usuario dijo su valor' : '';
    return i === 0 ? `"${c}" (${columnasBonitas[i]}) — es el nombre del registro: en "nombre" va SOLO el valor de esta columna (${columnasBonitas[i]}), sin el resto de la frase; lo demás va en "valores"` : `"${c}" (${columnasBonitas[i]})${calculada}`;
  }).join('\n- ');
  return (
    `Extrae los registros que el usuario quiere cargar en un cuadro.\n` +
    `Columnas del cuadro (usa EXACTAMENTE estas claves):\n- ${lista}\n\n` +
    `Responde SOLO con JSON, sin texto adicional: {"filas":[{"nombre":"...","valores":{"clave":"valor"},"otros":["..."]}]}\n` +
    `Reglas:\n` +
    `- Una entrada por persona o registro, en el orden en que los dijo. Máximo ${MAX_FILAS_CARGA}.\n` +
    `- "nombre": tal cual lo dijo (sin corregir ortografía).\n` +
    `- "valores": SOLO las columnas que el usuario mencionó para ese registro, con la clave exacta de arriba y el valor tal cual lo dijo (ej. "460", "$1,200"). NUNCA calcules ni deduzcas montos, intereses ni saldos y NUNCA inventes valores.\n` +
    `- Si algo que dijo no encaja con certeza en una columna (un porcentaje como "al 10%", una fecha suelta, una frase), NO lo pongas en "valores": ponlo en "otros" tal cual lo dijo.\n` +
    `- Ignora las palabras de la orden ("agrega", "carga estos", el nombre del cuadro, "por favor").\n\n` +
    `Mensaje del usuario: ${JSON.stringify(texto)}`
  );
}

/** Valida la respuesta de Groq y la deja en la forma que espera armarFilasNuevas. */
export function normalizarExtraccion(obj) {
  const lista = Array.isArray(obj) ? obj : obj?.filas;
  if (!Array.isArray(lista)) return null;
  return lista.map(e => ({
    nombre: e?.nombre,
    valores: e?.valores && typeof e.valores === 'object' && !Array.isArray(e.valores) ? e.valores : {},
    otros: Array.isArray(e?.otros) ? e.otros : [],
  }));
}

/** Cuántos registros trae el mensaje, más o menos (separadores o números, lo que dé más). Solo dimensiona la respuesta. */
export function estimarRegistros(texto) {
  const t = String(texto ?? '');
  const separadores = t.split(/[\n;,]| y /).filter(s => s.trim()).length;
  const numeros = (t.match(/\d+(?:[.,]\d+)?/g) || []).length;
  return Math.max(1, separadores, numeros);
}

/** Tope de tokens de la respuesta: ~80 por registro, entre 600 y 2000 (así una carga corta no reserva de más). */
export function maxTokensExtraccion(texto) {
  return Math.min(2000, Math.max(600, 500 + 80 * estimarRegistros(texto)));
}

/**
 * Llamada pequeña a Groq: solo transcribe el mensaje a filas crudas. `fetchFn` es el fetchGroq de whatsapp.js.
 * Lanza un Error con `.codigo`: 'limite' (429/413: Groq saturado), 'formato' (no devolvió JSON usable o se cortó).
 */
export async function extraerFilasDeTexto(texto, columnasBonitas, columnasInternas, reglas, groqApiKey, fetchFn) {
  const respuesta = await fetchFn('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: construirPromptExtraccion(texto, columnasBonitas, columnasInternas, reglas) }],
      temperature: 0,
      max_tokens: maxTokensExtraccion(texto),
      response_format: { type: 'json_object' },
    }),
  });
  const data = await respuesta.json();
  if (data.error) {
    const e = new Error(`Groq (carga de filas): ${data.error.message}`);
    e.codigo = respuesta.status === 429 || respuesta.status === 413 ? 'limite' : 'groq';
    throw e;
  }
  const eleccion = data.choices?.[0];
  if (eleccion?.finish_reason === 'length') {
    const e = new Error('La lectura de los registros se cortó (mensaje muy largo).');
    e.codigo = 'formato';
    throw e;
  }
  const mensaje = eleccion?.message;
  const texto2 = (mensaje?.content || mensaje?.reasoning_content || mensaje?.reasoning || '').trim();
  const limpio = texto2.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let filas = null;
  try { filas = normalizarExtraccion(JSON.parse(limpio)); } catch { filas = null; }
  if (!filas) {
    const e = new Error('Groq no devolvió los registros en un formato usable.');
    e.codigo = 'formato';
    throw e;
  }
  return filas;
}

// ── Vista previa ────────────────────────────────────────────────────────────────────────────────────

const LIMITE_TEXTO = 3300;

export function textoVistaPreviaCarga(datos) {
  const internas = datos.columnasInternas;
  const claveNombre = internas[0];
  const lineas = datos.filas.map((f, i) => {
    const partes = internas.slice(1)
      .filter(c => f[c] !== undefined && f[c] !== null)
      .map(c => `${datos.columnasBonitas[internas.indexOf(c)]} ${f[c]}`);
    return `${i + 1}. ${f[claveNombre]}${partes.length ? ` — ${partes.join(', ')}` : ''}`;
  });

  let cuerpo = '';
  let mostradas = 0;
  for (const l of lineas) {
    if ((cuerpo + l).length > LIMITE_TEXTO) break;
    cuerpo += `${l}\n`;
    mostradas++;
  }
  if (mostradas < lineas.length) cuerpo += `…y ${lineas.length - mostradas} más (se cargan todos)\n`;

  const n = datos.filas.length;
  const encabezado = datos.modo === 'nuevo'
    ? `Voy a crear el cuadro "${datos.nombreCuadro}" con ${n} registro(s):`
    : `Voy a agregar ${n} registro(s) al cuadro "${datos.nombreCuadro}":`;

  let texto = `${encabezado}\n\n${cuerpo.trimEnd()}`;
  if ((datos.avisos || []).length > 0) texto += `\n\n⚠️ ${datos.avisos.join('\n⚠️ ')}`;
  if ((datos.sinAsignar || []).length > 0) {
    texto += `\n\nNo supe dónde poner (no lo guardé):\n${datos.sinAsignar.map(s => `• ${s.nombre}: ${s.texto}`).join('\n')}`;
  }
  if ((datos.omitidas || []).length > 0) {
    texto += `\n\nNo agregué:\n${datos.omitidas.map(o => `• ${o}`).join('\n')}`;
  }
  texto += `\n\n¿Los ${datos.modo === 'nuevo' ? 'creo' : 'agrego'}? Responde "sí" para guardar, "no" para descartar, o corrige: "quita a Susan", "el monto de Carlos es 460", "agrega a Ana, monto 100".`;
  return texto;
}

// ── Respuestas del usuario a la vista previa ────────────────────────────────────────────────────────

/** "quita a Susan" → { tipo:'quitar', nombre:'Susan' } · "agrega a Ana, monto 100" → { tipo:'agregar' } · otra cosa → null */
export function detectarCorreccionCarga(texto) {
  const t = String(texto ?? '').trim();
  const sin = sinTildes(t);
  const q = sin.match(/^(?:quita|quitar|quitale|elimina|eliminar|borra|borrar|saca|sacar|remueve)\s+(?:a\s+|al\s+|la\s+|el\s+)?(.+?)[\s.!]*$/);
  if (q) {
    // el nombre se toma del texto original (con sus tildes), en la misma posición
    const inicio = sin.lastIndexOf(q[1]);
    const nombre = t.slice(inicio, inicio + q[1].length).trim();
    return /\p{L}{2,}/u.test(nombre) ? { tipo: 'quitar', nombre } : null; // "quita a" a secas no es un nombre
  }
  if (/^(?:agrega|agregar|agregale|anade|anadir|suma|sumar|incluye|incluir|y tambien|tambien|ademas)\b/.test(sin)) return { tipo: 'agregar' };
  return null;
}

/**
 * ¿Parece una carga de varios registros, uno por línea? (red de seguridad por si Groq usa agregar_fila una sola vez).
 * Cuenta líneas que tienen una palabra y un número.
 */
export function contarRegistrosPorLinea(texto) {
  return String(texto ?? '').split(/\r?\n|;/)
    .map(l => l.trim())
    .filter(l => /\p{L}/u.test(l) && /\d/.test(l)).length;
}

/**
 * Red de seguridad determinista: Groq a veces responde a "agrega a Carlos 460, Susan 300..." con VARIAS llamadas
 * a agregar_fila (el webhook solo ejecuta la primera → se perdían los demás en silencio) o con una sola.
 * Si pasa, se redirige a cargar_filas. Devuelve null si no hay nada que corregir.
 */
export function reencaminarACargaFilas(textoUsuario, toolCalls) {
  const llamadas = Array.isArray(toolCalls) ? toolCalls : [];
  if (llamadas.length === 0 || !llamadas.every(l => l?.function?.name === 'agregar_fila')) return null;
  const varias = llamadas.length >= 2;
  const porLineas = llamadas.length === 1 && contarRegistrosPorLinea(textoUsuario) >= 3;
  if (!varias && !porLineas) return null;
  let nombreCuadro = null;
  try { nombreCuadro = JSON.parse(llamadas[0].function.arguments || '{}').nombre_cuadro || null; } catch { nombreCuadro = null; }
  return { nombre: 'cargar_filas', args: { nombre_cuadro: nombreCuadro } };
}