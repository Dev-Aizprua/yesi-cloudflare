// functions/lib/buscarFila.js
// Encuentra la fila correspondiente a un nombre que el cliente
// mencionó por voz/texto, usando fuzzy-match determinístico.
// Groq NUNCA decide esto — solo extrae el nombre tal cual lo dijo
// el usuario (ej. "Yise"); este módulo decide a quién corresponde
// de verdad dentro del cuadro (ej. "Yisel").
//
// npm install fuzzysort

import fuzzysort from 'fuzzysort';

// Umbrales ajustables. fuzzysort da scores negativos donde 0 es
// coincidencia perfecta y más negativo es peor match. Estos son
// valores de partida — hay que afinarlos con uso real del cliente
// piloto una vez que veamos nombres/errores reales.
const UMBRAL_COINCIDENCIA_ALTA = -200; // por debajo de esto, no se considera la misma persona
const MARGEN_AMBIGUEDAD        = 30;   // si el 2do candidato queda a menos de esto del 1ro, hay ambigüedad real

/**
 * Busca en las filas de un cuadro cuál corresponde al nombre dicho
 * por el cliente.
 *
 * @param {string} nombreMencionado - nombre tal cual lo extrajo Groq (ej. "Yise")
 * @param {Array}  filas            - filas del cuadro, cada una con un campo "nombre"
 * @returns {{
 *   tipo: 'exacto' | 'alto' | 'ambiguo' | 'no_encontrado',
 *   fila: Object|null,
 *   candidatos: Object[],
 *   aviso: string|null   // texto listo para incluir en la respuesta al cliente
 * }}
 */
export function buscarFila(nombreMencionado, filas) {
  if (!nombreMencionado || !filas || filas.length === 0) {
    return { tipo: 'no_encontrado', fila: null, candidatos: [], aviso: null };
  }

  const nombreNormalizado = nombreMencionado.trim().toLowerCase();

  // 1. Coincidencia exacta primero — no gastamos fuzzy-match si no hace falta
  const exacta = filas.find(f => (f.nombre || '').trim().toLowerCase() === nombreNormalizado);
  if (exacta) {
    return { tipo: 'exacto', fila: exacta, candidatos: [exacta], aviso: null };
  }

  // 2. Fuzzy-match contra todos los nombres del cuadro
  const resultados = fuzzysort.go(nombreMencionado, filas, { key: 'nombre' });

  if (resultados.length === 0) {
    return { tipo: 'no_encontrado', fila: null, candidatos: [], aviso: null };
  }

  const mejor   = resultados[0];
  const segundo = resultados[1];

  // Sin coincidencia suficientemente buena — probablemente es un
  // nombre nuevo, no un error de transcripción de uno existente
  if (mejor.score < UMBRAL_COINCIDENCIA_ALTA) {
    return { tipo: 'no_encontrado', fila: null, candidatos: [], aviso: null };
  }

  // Dos candidatos muy parecidos entre sí — ambigüedad real, se pregunta
  if (segundo && (mejor.score - segundo.score) < MARGEN_AMBIGUEDAD) {
    return {
      tipo: 'ambiguo',
      fila: null,
      candidatos: [mejor.obj, segundo.obj],
      aviso: `Tengo a ${mejor.obj.nombre} y ${segundo.obj.nombre} en el cuadro, ¿a cuál te refieres?`
    };
  }

  // Coincidencia alta pero no exacta — se aplica, pero con transparencia
  return {
    tipo: 'alto',
    fila: mejor.obj,
    candidatos: [mejor.obj],
    aviso: `Actualicé a ${mejor.obj.nombre} (interpreté que te referías a esa persona).`
  };
}