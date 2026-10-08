// functions/lib/motorCartas.js
// Motor genérico de cartas. Mismo principio de siempre: Groq solo
// extrae los datos crudos que el usuario dictó (nunca inventa un
// campo que falta, nunca decide qué plantilla "cree" que aplica sin
// que el catálogo lo respalde) — todo lo de aquí es determinístico.
//
// GENERACIÓN DE .DOCX — nota importante sobre la librería `docx`:
// usamos Packer.toArrayBuffer(), NO Packer.toBuffer(). toBuffer()
// depende de la clase Buffer de Node, que Cloudflare Workers no trae
// a menos que se active el flag "nodejs_compat" (no está activado en
// este proyecto). toArrayBuffer() usa el modo interno "arraybuffer"
// de JSZip, que es JS puro — mismo tipo de dato (convertido a
// Uint8Array) que ya devuelven generarImagenCuadro() y
// generarExcelCuadro(), así que encaja con el mismo patrón de envío.

import { Document, Packer, Paragraph, TextRun, AlignmentType } from 'docx';

/**
 * Compara lo ya capturado contra los campos_requeridos de la
 * plantilla y devuelve los que todavía faltan (o vienen vacíos).
 *
 * @param {Object} plantilla        de obtenerPlantilla()
 * @param {Object} camposCapturados { [id]: valor }
 * @returns {Array} campos_requeridos que faltan, en el mismo formato del catálogo
 */
export function camposFaltantes(plantilla, camposCapturados) {
  return plantilla.camposRequeridos.filter(campo => {
    const valor = camposCapturados[campo.id];
    return valor === undefined || valor === null || String(valor).trim() === '';
  });
}

/**
 * Reemplaza los placeholders del cuerpo de una plantilla:
 *   {{campo}}                       → valor tal cual, o "" si no existe
 *   {{#campo}}...{{/campo}}         → el bloque interno se conserva
 *                                      SOLO si "campo" tiene valor no vacío
 *
 * Sintaxis intencionalmente mínima (subset de Mustache) — no acepta
 * anidar bloques ni loops, porque las plantillas de carta no los
 * necesitan y así se puede implementar en JS puro, sin librería.
 */
export function renderizarCuerpo(cuerpo, campos) {
  // Primero los bloques opcionales {{#campo}}...{{/campo}}
  let salida = cuerpo.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_, campoId, contenido) => {
      const valor = campos[campoId];
      const tieneValor = valor !== undefined && valor !== null && String(valor).trim() !== '';
      return tieneValor ? contenido : '';
    }
  );

  // Luego los placeholders simples {{campo}}
  salida = salida.replace(/\{\{(\w+)\}\}/g, (_, campoId) => {
    const valor = campos[campoId];
    return valor === undefined || valor === null ? '' : String(valor);
  });

  return salida;
}

const FECHA_LARGA = new Intl.DateTimeFormat('es-PA', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Panama',
});

// Mejora pedida: mayúscula inicial automática (ej. "condominio" →
// "Condominio"). Deliberadamente NO es un Title Case de cada palabra
// (eso rompería frases como "administración del condominio", donde
// "del" debe quedar en minúscula) — solo la primera letra del valor,
// que sirve igual de bien para un nombre corto que para el inicio de
// una oración larga como "motivo".
function capitalizarInicio(texto) {
  const t = String(texto ?? '').trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}
export { capitalizarInicio };

function nombreArchivo(nombrePlantilla) {
  const base = String(nombrePlantilla)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${base || 'carta'}.docx`;
}

/**
 * Arma el .docx final: membrete (de configuracion_negocio) + cuerpo
 * ya renderizado con los datos capturados + firma. Mismo "chasis"
 * visual del mockup que ya vio Eduardo — un solo layout reutilizado
 * para todas las plantillas del catálogo.
 *
 * @param {Object} plantilla   de obtenerPlantilla()
 * @param {Object} campos      { [id]: valor } ya completos (sin faltantes)
 * @param {Object} configNegocio  fila de configuracion_negocio (puede ser null si el negocio no la configuró aún)
 * @returns {Promise<{ bytes: Uint8Array, nombreArchivo: string, mime: string }>}
 */
export async function generarDocxCarta(plantilla, campos, configNegocio) {
  let membreteNegocio = {};
  try {
    membreteNegocio = configNegocio?.membrete_carta ? JSON.parse(configNegocio.membrete_carta) : {};
  } catch (e) {
    membreteNegocio = {}; // membrete mal formado no debe tumbar la generación de la carta
  }

  // "Sin encabezado" (solo para ESTA carta, marcado por whatsapp.js con
  // _sin_encabezado): no se usa ningún dato del negocio arriba ni en la
  // línea de la fecha (una ciudad ajena podría no corresponder a quien
  // pidió la carta). La firma sí conserva su regla de siempre.
  const membrete = campos._sin_encabezado === true ? {} : membreteNegocio;

  // Copia SOLO para mostrar en el documento (con mayúscula inicial).
  // Los "campos" originales, sin tocar, son los que se guardan en
  // documentos_generados para auditoría — no se pierde el dato crudo.
  const camposParaMostrar = {};
  for (const [id, valor] of Object.entries(campos)) {
    if (id.startsWith('_')) continue; // marcas internas (ej. _sin_encabezado), no son datos de la carta
    camposParaMostrar[id] = capitalizarInicio(valor);
  }

  // Quién firma: por defecto el negocio (membrete/firma_carta), PERO
  // si la plantilla define de qué campo sale el firmante (ej. una
  // carta en primera persona, donde firma quien solicita y no el
  // negocio que renta el bot) y ese campo SÍ tiene valor, se usa ese.
  // Si la plantilla no lo define, o el campo vino vacío, cae solo al
  // membrete — nunca es obligatorio configurarlo.
  let firmaNombre = configNegocio?.firma_carta || membreteNegocio.nombre || '';
  let firmaCedula = null;
  if (plantilla.campoFirmaNombre && campos[plantilla.campoFirmaNombre]) {
    firmaNombre = camposParaMostrar[plantilla.campoFirmaNombre];
    if (plantilla.campoFirmaCedula && campos[plantilla.campoFirmaCedula]) {
      firmaCedula = campos[plantilla.campoFirmaCedula];
    }
  }

  const fechaHoy = FECHA_LARGA.format(new Date());
  const ciudad = membrete.direccion || '';

  const cuerpoRenderizado = renderizarCuerpo(plantilla.cuerpo, camposParaMostrar);
  // Cada línea en blanco del cuerpo se vuelve su propio párrafo — la
  // librería docx no interpreta "\n" dentro de un solo TextRun.
  const parrafosCuerpo = cuerpoRenderizado.split('\n').map(linea =>
    new Paragraph({ children: [new TextRun({ text: linea })], spacing: { after: 120 } })
  );

  const children = [];

  if (membrete.nombre) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: membrete.nombre, bold: true, size: 32 })],
    }));
  }
  if (membrete.ruc || membrete.direccion) {
    const partes = [membrete.ruc ? `RUC: ${membrete.ruc}` : null, membrete.direccion].filter(Boolean);
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: partes.join('  ·  '), size: 20, color: '555555' })],
      spacing: { after: 400 },
    }));
  }

  children.push(...parrafosCuerpo);

  children.push(new Paragraph({ text: '', spacing: { after: 400 } }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: `${ciudad ? ciudad + ', ' : ''}${fechaHoy}` })],
    spacing: { after: 800 },
  }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '_______________________________' })] }));
  if (firmaNombre) {
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: firmaNombre, bold: true })] }));
  }
  if (firmaCedula) {
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `Cédula: ${firmaCedula}`, size: 20, color: '555555' })] }));
  }

  const doc = new Document({
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 } } }, // US Letter
      children,
    }],
  });

  const arrayBuffer = await Packer.toArrayBuffer(doc);

  return {
    bytes: new Uint8Array(arrayBuffer),
    nombreArchivo: nombreArchivo(plantilla.nombre),
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
}