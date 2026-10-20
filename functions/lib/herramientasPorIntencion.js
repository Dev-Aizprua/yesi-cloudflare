// functions/lib/herramientasPorIntencion.js
// Selección de herramientas por mensaje. Cada petición a Groq lleva las 15 herramientas
// (~5,100 tokens), las reglas y una línea por cuadro: con el límite de 8,000 tokens por minuto del
// plan gratis, un solo mensaje ya pasaba el tope (error 413, que NO se arregla esperando).
//
// El CÓDIGO (no Groq) decide qué grupos de herramientas ofrecer según lo que dijo el usuario:
//   - "cuadro" (agregar/actualizar/eliminar fila, consultar, crear/eliminar cuadro) se ofrece SIEMPRE.
//   - los demás grupos se suman si el mensaje —o uno de los 2 mensajes anteriores del usuario, para los
//     seguimientos tipo "y a Pedro también"— menciona algo de ese tema.
// Los patrones son GENEROSOS a propósito: un falso positivo solo cuesta unos tokens; un falso negativo
// dejaría a Groq sin la herramienta que hacía falta.

export const GRUPOS_HERRAMIENTAS = {
  cuadro: ['crear_cuadro', 'agregar_fila', 'cargar_filas', 'actualizar_fila', 'eliminar_fila', 'consultar_cuadro', 'eliminar_cuadro'],
  documentos: ['crear_cotizacion', 'crear_factura_proforma', 'convertir_cotizacion_en_factura', 'enviar_pdf', 'consultar_cuadro'],
  pagos: ['registrar_pago', 'ajustar_pago', 'actualizar_fila'],
  archivos: ['enviar_excel', 'enviar_pdf', 'consultar_cuadro'],
  cobro: ['generar_cobro', 'consultar_cuadro'],
  cartas: ['generar_carta'],
};

// Se aplican sobre texto SIN tildes y en minúsculas.
const PATRONES = {
  documentos: /\b(cotiz\w*|factur\w*|proforma\w*|presupuest\w*|nota de (?:cobro|venta)|convert\w*|pasa\w* a factura|pdf)\b/,
  pagos: /\b(pag(?:o|os|ue|ues|ar|aron|ado|ada|ando)|abon\w*|cancel\w*|salda\w*|saldo|favor|anul\w*|deshac\w*|deshaz\w*|deshech\w*|equivoc\w*|equivoq\w*|revert\w*|devolu\w*)\b/,
  archivos: /\b(excel|xlsx|pdf|hoja\w*|archivo\w*|imagen\w*|foto\w*|pantallazo|captura|descarg\w*|envia\w*|manda\w*|pasa\w*|muestra\w*|ver)\b/,
  cobro: /\b(cobr\w*|recordatorio\w*|recuerd\w*|reclam\w*|moroso\w*|moros\w*|deud\w*|deben?|debe|lista de cobros)\b/,
  cartas: /\b(cart\w*|poder|constancia\w*|certific\w*|autoriza\w*|solicitud\w*|declaraci\w*|renuncia\w*|permiso\w*|contrato\w*|word|docx|documento\w*|plantilla\w*)\b/,
};

const sinTildes = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * @param {string[]} textos  mensajes recientes del usuario (el actual primero; basta con los últimos 3)
 * @returns {Set<string>} grupos a ofrecer ("cuadro" siempre incluido)
 */
export function elegirGrupos(textos) {
  const grupos = new Set(['cuadro']);
  for (const texto of textos || []) {
    const t = sinTildes(texto);
    if (!t) continue;
    for (const [grupo, patron] of Object.entries(PATRONES)) if (patron.test(t)) grupos.add(grupo);
  }
  return grupos;
}

/** Herramientas (objetos completos) que corresponden a los grupos elegidos. */
export function filtrarHerramientas(todas, grupos) {
  const nombres = new Set();
  for (const g of grupos) for (const n of GRUPOS_HERRAMIENTAS[g] || []) nombres.add(n);
  return todas.filter(h => nombres.has(h.function.name));
}