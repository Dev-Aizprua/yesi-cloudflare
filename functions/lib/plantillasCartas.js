// functions/lib/plantillasCartas.js
// Acceso a D1 para el catálogo de plantillas de carta. Sin lógica de
// negocio aquí — eso vive en motorCartas.js. Este archivo solo lee.

/**
 * Lista liviana (solo id/nombre/categoria) para el system prompt de
 * Groq — nunca se le manda el "cuerpo" completo de cada plantilla,
 * así el catálogo puede crecer a 30+ sin subir el costo por mensaje.
 */
export async function listarPlantillasActivas(env) {
  const { results } = await env.oficina_ia_db.prepare(
    'SELECT id, nombre, categoria FROM plantillas_carta WHERE activa = 1'
  ).all();
  return results;
}

/**
 * Lista para el system prompt: incluye los campos (para que Groq
 * sepa qué "ids" usar al llenar "campos" en generar_carta), pero
 * SIN el "cuerpo" — eso es lo único pesado, y nunca hace falta para
 * elegir la plantilla ni para extraer datos.
 */
export async function listarPlantillasParaPrompt(env) {
  const { results } = await env.oficina_ia_db.prepare(
    'SELECT id, nombre, categoria, campos_requeridos, campos_opcionales FROM plantillas_carta WHERE activa = 1'
  ).all();
  return results.map(fila => ({
    id: fila.id,
    nombre: fila.nombre,
    categoria: fila.categoria,
    camposRequeridos: JSON.parse(fila.campos_requeridos || '[]'),
    camposOpcionales: JSON.parse(fila.campos_opcionales || '[]'),
  }));
}

/**
 * Trae una plantilla completa por id, con los campos JSON ya parseados.
 * Devuelve null si no existe o está desactivada.
 */
export async function obtenerPlantilla(env, plantillaId) {
  const fila = await env.oficina_ia_db.prepare(
    'SELECT * FROM plantillas_carta WHERE id = ? AND activa = 1 LIMIT 1'
  ).bind(plantillaId).first();

  if (!fila) return null;

  return {
    id: fila.id,
    nombre: fila.nombre,
    categoria: fila.categoria,
    camposRequeridos: JSON.parse(fila.campos_requeridos || '[]'),
    camposOpcionales: JSON.parse(fila.campos_opcionales || '[]'),
    cuerpo: fila.cuerpo,
    // De qué campo sale el nombre/cédula de quien FIRMA la carta (ej.
    // "solicitante" en vez del negocio) — null/vacío si esta plantilla
    // no lo define, y entonces motorCartas.js cae al membrete del
    // negocio como firma. Nunca es obligatorio configurarlo.
    campoFirmaNombre: fila.campo_firma_nombre || null,
    campoFirmaCedula: fila.campo_firma_cedula || null,
  };
}