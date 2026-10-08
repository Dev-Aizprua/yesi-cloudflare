// functions/lib/groqReintento.js
// Cuando Groq responde 429 (límite de tokens/peticiones por minuto), casi siempre
// dice cuánto esperar ("Please try again in 3.24s"). En vez de perder el mensaje
// del usuario, se espera ese tiempo y se REINTENTA UNA SOLA VEZ. Si lo que hay que
// esperar es largo (p. ej. un límite diario: "try again in 10m"), no se espera: se
// devuelve la respuesta 429 tal cual para que quien llama avise al usuario.
//
// Solo mira el estado HTTP, el encabezado retry-after y el texto del error: no
// toca ni interpreta nada del contenido de la conversación.

const ESPERA_MAXIMA_MS = 8000;   // más que esto no vale la pena esperar dentro de un mensaje de WhatsApp
const ESPERA_POR_DEFECTO_MS = 2000; // 429 sin pista de cuánto esperar
const MARGEN_MS = 250;           // un poco más de lo que pide Groq, por si acaso

/**
 * "3.24s" → 3240, "1m2.5s" → 62500, "250ms" → 250, "1h2m3s" → 3723000.
 * @returns {number|null} milisegundos, o null si no se entiende
 */
export function milisegundosDeDuracion(texto) {
  const partes = [...String(texto ?? '').matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/gi)];
  if (partes.length === 0) return null;
  const unidad = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  return Math.round(partes.reduce((acc, p) => acc + Number(p[1]) * unidad[p[2].toLowerCase()], 0));
}

/**
 * Cuánto esperar según el encabezado retry-after (segundos) o el texto del error.
 * @returns {number|null} ms, o null si no hay pista
 */
export function esperaSugeridaMs(retryAfter, cuerpoTexto) {
  if (retryAfter !== null && retryAfter !== undefined && String(retryAfter).trim() !== '') {
    const seg = Number(retryAfter);
    if (Number.isFinite(seg) && seg >= 0) return Math.round(seg * 1000);
  }
  const m = String(cuerpoTexto ?? '').match(/try again in\s+([0-9hms.]+)/i);
  return m ? milisegundosDeDuracion(m[1]) : null;
}

/**
 * fetch a Groq con UN reintento si responde 429 y la espera es corta.
 * @param {Function} fetchFn   fetch (inyectable para probar)
 * @param {string} url
 * @param {object} init        igual que fetch; el body debe poder enviarse dos veces (string o FormData)
 * @param {{ dormir?: (ms:number)=>Promise<void>, maxEsperaMs?: number }} [opciones]
 * @returns {Promise<Response>}
 */
export async function llamarGroqConReintento(fetchFn, url, init, opciones = {}) {
  const dormir = opciones.dormir || (ms => new Promise(r => setTimeout(r, ms)));
  const maxEsperaMs = opciones.maxEsperaMs ?? ESPERA_MAXIMA_MS;

  const primera = await fetchFn(url, init);
  if (primera.status !== 429) return primera;

  let cuerpo = '';
  try { cuerpo = await primera.clone().text(); } catch { /* sin cuerpo legible: se usa la espera por defecto */ }
  const sugerida = esperaSugeridaMs(primera.headers?.get?.('retry-after'), cuerpo);
  const espera = (sugerida ?? ESPERA_POR_DEFECTO_MS) + MARGEN_MS;

  if (espera > maxEsperaMs) {
    console.log(`[GROQ] 429 con espera de ${espera} ms (> ${maxEsperaMs}): no se reintenta`);
    return primera;
  }
  console.log(`[GROQ] 429 — esperando ${espera} ms y reintentando una vez`);
  await dormir(espera);
  return await fetchFn(url, init);
}