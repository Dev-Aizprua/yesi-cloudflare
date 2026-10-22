// functions/lib/atajoArchivos.js
// Atajo en código para "pásame el Excel / el PDF de X": se detecta el pedido sin llamar a Groq (0 tokens de
// modelo, ~2,300 menos por pedido) y se entrega con la MISMA ruta de siempre (enviar_excel / enviar_pdf).
// Regla de seguridad: el atajo solo actúa si el pedido es inequívoco (palabra de formato + verbo de pedir) y
// el cuadro se puede resolver con certeza; si hay duda, devuelve null y el mensaje sigue por Groq.

const sinTildes = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const plano = t => sinTildes(t).replace(/[¿?¡!.,;:"“”«»]/g, ' ').replace(/\s+/g, ' ').trim();

const RE_FORMATO_EXCEL = /\b(excel|xlsx|hoja de calculo|hoja de excel)\b/;
const RE_FORMATO_PDF = /\bpdf\b/;
const RE_PEDIR = /\b(pasa\w*|manda\w*|envia\w*|enviar|dame|damelo|dime|quiero|quisiera|necesito|descarg\w*|sacame|saca|ver|muestra\w*|genera\w*|exporta\w*|bajar|baja)\b/;
// Intenciones que NO son "dame el archivo": crear documentos, cartas, convertir, programar envíos.
const RE_OTRA_INTENCION = /\b(haz|hazme|hacer|crea\w*|arma\w*|elabora\w*|prepara\w*|redacta\w*|escribe|carta|constancia|convierte|convertir|cotiz\w* nueva|nueva cotiz\w*|cada|todos los|todas las|programa\w*|recordatorio|agrega\w*|anota\w*|registra\w*|vendi|gaste)\b|\ba factura\b|\ben factura\b/;
const RE_IMAGEN = /\b(imagen|foto|captura|pantallazo)\b/;

const RELLENO_FINAL = /\s+(?:por favor|porfa|gracias|ahora|ya|ahorita|please)\s*$/i;
const RELLENO_INICIO = /^(?:(?:del?|la|el|los|las|un|una|mi|mis|este|esta|ese|esa|archivo|hoja|tabla|cuadro|en)\s+)+/i;

/**
 * @param {string} texto  lo que escribió o dictó el usuario
 * @returns {{ formato: 'excel'|'pdf', frase: string|null, conImagen: boolean } | null}
 */
export function detectarPedidoArchivo(texto) {
  const original = String(texto ?? '').replace(/\s+/g, ' ').trim();
  const t = plano(original);
  if (!t || t.length > 120) return null;
  const esExcel = RE_FORMATO_EXCEL.test(t);
  const esPdf = RE_FORMATO_PDF.test(t);
  if (esExcel === esPdf) return null; // ninguno, o los dos a la vez: se deja a Groq
  if (RE_OTRA_INTENCION.test(t)) return null;
  const empiezaConFormato = /^(?:el |la |un |una )?(?:excel|xlsx|pdf|hoja de calculo)\b/.test(t);
  if (!RE_PEDIR.test(t) && !empiezaConFormato) return null;

  // Nombre dicho: lo que va después de la palabra de formato ("el Excel del cuadro Préstamos") o antes de
  // "en Excel/PDF" ("dame Préstamos en Excel"). Se toma del texto ORIGINAL para conservar mayúsculas y tildes.
  const rxFormato = esExcel ? '(?:excel|xlsx|hoja de c[aá]lculo|hoja de excel)' : 'pdf';
  let frase = null;
  const despues = original.match(new RegExp(`${rxFormato}\\s+(?:de(?:l)?|para)\\s+(.+)$`, 'i'));
  const antes = original.match(new RegExp(`(?:^|\\s)(?:el|la|los|las)?\\s*(?:cuadro|tabla)?\\s*(.+?)\\s+en\\s+${rxFormato}\\b`, 'i'));
  if (despues) frase = despues[1];
  else if (antes) {
    // "pásame el cuadro Préstamos en Excel": quitar el verbo del principio
    frase = antes[1].replace(/^(?:p[aá]same|m[aá]ndame|env[ií]ame|dame|quiero|necesito|quisiera|mu[eé]strame|s[aá]came|d[ií]me)\s+/i, '');
  }
  if (frase) {
    frase = frase.replace(/[¿?¡!.,;:"“”]+/g, ' ').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 3; i++) frase = frase.replace(RELLENO_FINAL, '').trim();
    frase = frase.replace(RELLENO_INICIO, '').trim();
    // el pedido pudo traer la imagen aparte ("... y la imagen"): no es parte del nombre
    frase = frase.replace(/\s+(?:y|con|mas|más)\s+(?:la\s+)?(?:imagen|foto|captura|pantallazo)\s*$/i, '').trim();
    if (frase.length < 2 || frase.length > 60 || /^(?:que|lo|eso|ese|esa|el|la)$/i.test(frase)) frase = null;
  }
  return { formato: esExcel ? 'excel' : 'pdf', frase, conImagen: esExcel && RE_IMAGEN.test(t) };
}

/**
 * Elige el cuadro del pedido entre los del negocio, SOLO si es seguro.
 * @param {Array<{nombre_cuadro: string}>} cuadros
 * @param {{ frase: string|null }} pedido
 * @param {{ resolverPorNombre: Function, buscarDocumento?: Function, formato: string }} ayudas
 * @returns {object|null}  el cuadro, o null si no hay certeza (el mensaje sigue por Groq)
 */
export function resolverCuadroDelPedido(cuadros, pedido, ayudas) {
  const lista = cuadros || [];
  if (lista.length === 0) return null;
  if (!pedido.frase) return lista.length === 1 ? lista[0] : null;
  const exacto = lista.find(c => sinTildes(c.nombre_cuadro) === sinTildes(pedido.frase));
  if (exacto) return exacto;
  const porNombre = ayudas.resolverPorNombre ? ayudas.resolverPorNombre(lista, pedido.frase) : null;
  if (porNombre) return porNombre;
  if (ayudas.formato === 'pdf') {
    // "la cotización 004" / "la factura 004": los documentos se llaman "Factura proforma 004 - Ana" o
    // "Cotización 004 - Ana". Si el pedido trae el número y SOLO UN documento lo tiene, es ese.
    const m = sinTildes(pedido.frase).match(/^(?:la |el )?(?:factura proforma|proforma|cotizacion|factura)\s+(?:no\.?\s*|numero\s+|#\s*)?0*(\d+)\s*$/);
    if (m) {
      const n = Number(m[1]);
      const hallados = lista.filter(c => {
        const k = sinTildes(c.nombre_cuadro).match(/^(?:factura proforma|proforma|cotizacion|factura)\s+0*(\d+)\b/);
        return k && Number(k[1]) === n;
      });
      if (hallados.length === 1) return hallados[0];
      if (hallados.length > 1) return null;
    }
  }
  if (ayudas.formato === 'pdf' && ayudas.buscarDocumento) return ayudas.buscarDocumento(lista, pedido.frase) || null;
  return null;
}