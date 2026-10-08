// functions/lib/visionCuadro.js
// Lee la foto de un cuadro (papel, Excel impreso, o a mano) y la
// transcribe a JSON con Groq. IMPORTANTE, siguiendo el mismo
// principio que el resto de Oficina IA: este módulo SOLO transcribe
// lo que ve — nunca calcula, nunca decide fórmulas con certeza. Eso lo
// hace detectorFormulas.js (tabla uniforme) o reporteSecciones.js
// (secciones), en JavaScript puro, después. Aquí Groq puede SUGERIR
// una fórmula para un reporte de secciones (ver más abajo), pero esa
// sugerencia nunca se acepta a ciegas — reporteSecciones.js la verifica
// aritméticamente antes de guardarla.
//
// Modelo: qwen/qwen3.8-27b. Groq dio de baja qwen/qwen3.6-27b (el que
// usaba Kairós, ver whatsapp.kairos.backup.js) el 14 de septiembre de
// 2026 — qwen3.8-27b es su reemplazo directo, documentado con las
// mismas capacidades (131K de contexto, modos thinking/instruct, tool
// use, modo JSON). Si Groq vuelve a retirar este modelo, revisar
// console.groq.com/docs/deprecations antes de cambiar el nombre a
// ciegas. El modo JSON es "best-effort", no "strict" (el modo
// estricto solo está disponible en unos pocos modelos), así que igual
// hay que parsear con cuidado — ver más abajo.
//
// ESQUEMA UNIFICADO (tipo "tabla" vs tipo "secciones"):
// Groq decide, mirando la imagen, cuál de los dos formatos describe
// mejor lo que ve:
//   - "tabla": una tabla de columnas y filas repetidas (ej. una lista
//     de préstamos, un inventario) — mismo formato que ya se usaba
//     antes de este cambio, sin modificar.
//   - "secciones": un reporte con una o más estadísticas destacadas
//     arriba (ej. "CAPITAL: 11,142") y uno o más bloques con nombre
//     (ej. "DETALLE"), cada uno con sus propias filas de etiqueta/valor
//     — no hay un patrón entre filas para detectar fórmulas, porque
//     cada sección aparece una sola vez (ej. Pago de Quincena).
// Si Groq no manda "tipo" (compatibilidad con respuestas viejas o un
// despiste del modelo), se asume "tabla" — el comportamiento de
// siempre, sin sorpresas.
//
// ENCABEZADO Y PIE DE UNA TABLA (pensado para facturas):
// El tipo "tabla" acepta dos campos OPCIONALES más. Si la imagen no
// los tiene (ej. una tabla de préstamos), llegan como [] y todo
// funciona igual que antes.
//   - "encabezado": datos sueltos ARRIBA de la tabla (negocio, RUC,
//     cliente, fecha, número). Si Groq no los lee con seguridad manda
//     valor null — NUNCA se inventa; tablaExtendida.js los deja
//     pendientes y el bot avisa "no identificado con seguridad —
//     quedará vacío".
//   - "pie": cadena de cálculos DEBAJO de la tabla (Subtotal →
//     ITBMS → Total a pagar). Cada fila puede traer formula_sugerida,
//     que tablaExtendida.js verifica contra el número real de la foto
//     (mismo "Groq propone, el código dispone" de "secciones").
//     Diferencia con "fila_totales": esa es una fila con un valor por
//     COLUMNA dentro de la tabla; el pie son líneas de UN solo valor.
//
// FÓRMULAS SUGERIDAS EN "secciones" (formula_sugerida):
// Para un reporte de secciones no hay 11 filas para comparar un
// patrón (ver detectorFormulas.js) — cada sección es un solo registro.
// En vez de eso, se le pide a Groq que SUGIERA la fórmula leyendo las
// etiquetas, usando las CLAVES INTERNAS (no las etiquetas bonitas) para
// evitar la ambigüedad de que, por ejemplo, "Capital" pueda referirse
// tanto a la estadística de resumen como a una fila de una sección
// (dos números distintos en el documento real). reporteSecciones.js
// VERIFICA cada sugerencia contra el valor real de la foto antes de
// aceptarla — si Groq se equivoca, no pasa nada: la fórmula se descarta
// y el valor queda fijo, igual que cualquier "Groq propone, código
// dispone" del resto del proyecto.

const FILA_TOTALES_ALIAS = 'fila_totales';

/**
 * Descarga una imagen recibida por WhatsApp, a partir de su media id.
 * Mismo patrón de 2 pasos que ya usaba Kairós: 1) pedirle a Meta la
 * URL temporal del archivo, 2) descargar esa URL con el mismo token.
 *
 * @returns {Promise<{ bytes: Uint8Array, mimeType: string }>}
 */
export async function descargarImagenWhatsApp(mediaId, waToken) {
  const mediaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${waToken}` },
  });
  const mediaData = await mediaRes.json();
  if (!mediaData.url) throw new Error('Meta no devolvió una URL para esta imagen.');

  const imageRes = await fetch(mediaData.url, {
    headers: { Authorization: `Bearer ${waToken}` },
  });
  const buffer = await imageRes.arrayBuffer();
  return { bytes: new Uint8Array(buffer), mimeType: mediaData.mime_type || 'image/jpeg' };
}

// Conversión a base64 seguro para imágenes grandes — igual que
// Kairós: convertir todo el arreglo de una vez con String.fromCharCode
// revienta el límite de argumentos del motor JS en imágenes de varios MB.
function bytesABase64(bytes) {
  let binario = '';
  const tamanoBloque = 8192;
  for (let i = 0; i < bytes.length; i += tamanoBloque) {
    binario += String.fromCharCode(...bytes.subarray(i, i + tamanoBloque));
  }
  return btoa(binario);
}

const PROMPT_VISION = `Vas a transcribir EXACTAMENTE lo que ves en esta imagen de un documento de negocio (puede ser una foto de un cuaderno, una hoja impresa, una captura de Excel, o algo escrito a mano). No calcules nada, no corrijas nada, no interpretes — copia los valores tal como aparecen.

Primero decide cuál de estas DOS formas describe mejor lo que ves:

── FORMA "tabla" ──
Úsala cuando la imagen es una tabla con columnas fijas y varias filas que REPITEN el mismo patrón (ej. una lista de préstamos, clientes, inventario, o las líneas de una factura — una fila por persona/producto).

Responde con este JSON exacto. Los campos "encabezado" y "pie" son OPCIONALES: usa [] si la imagen no los tiene (una tabla de préstamos normalmente no los tiene; una factura sí):
{
  "tipo": "tabla",
  "titulo": "texto del título principal, o null si no hay uno visible",
  "subtitulo": "una segunda línea debajo del título, como una fecha, o null si no hay",
  "encabezado": [
    { "etiqueta": "Cliente", "valor": "Eduardo Aizprua" },
    { "etiqueta": "RUC", "valor": null }
  ],
  "columnas": ["Nombre de columna 1", "Nombre de columna 2", "..."],
  "filas": [
    { "Nombre de columna 1": "valor", "Nombre de columna 2": 123 }
  ],
  "fila_totales": { "Nombre de columna 2": 999 },
  "pie": [
    { "etiqueta": "SUBTOTAL", "valor": 250, "formula_sugerida": "resumen_suma_total" },
    { "etiqueta": "ITBMS 7%", "valor": 17.5, "formula_sugerida": "subtotal * 0.07" },
    { "etiqueta": "TOTAL A PAGAR", "valor": 267.5, "formula_sugerida": "subtotal + itbms_7" }
  ]
}
- Las claves dentro de cada fila deben ser EXACTAMENTE los mismos textos que pusiste en "columnas", letra por letra.
- "fila_totales" es SOLO una fila de "Total" o "Suma" DENTRO de la tabla, con un valor por columna (alineada con las columnas). NO la incluyas dentro de "filas" — ponla aparte en "fila_totales". Si no hay una fila así, usa null.

Reglas para "encabezado" (datos sueltos ARRIBA de la tabla: nombre del negocio, RUC, teléfono, cliente, fecha, número de factura, fecha de vencimiento...):
- Copia cada dato tal como aparece. Si un dato no trae etiqueta (ej. el nombre del negocio en una línea sola), ponle una etiqueta corta y descriptiva ("Negocio").
- Si una etiqueta está en la imagen pero su valor está en blanco, borroso o no lo puedes leer con SEGURIDAD: pon "valor": null. NUNCA inventes ni completes un valor dudoso — es preferible null, el sistema se lo pregunta al usuario.
- No inventes campos que no aparezcan en la imagen. Si no hay nada de esto, usa [].

Reglas para "pie" (líneas de cálculo DEBAJO de la tabla, cada una con UNA etiqueta y UN solo valor: Subtotal, Descuento, ITBMS/impuesto, Total a pagar...):
- Van en orden, tal como aparecen de arriba a abajo. NO las pongas en "fila_totales" ni en "filas".
- Si el valor de una línea del pie no se puede leer con seguridad, pon "valor": null. No lo calcules tú.
- "formula_sugerida" es null para un dato crudo (ej. un descuento que alguien escribió a mano). SOLO sugiere una fórmula cuando se vea claro que el valor sale de otros valores de la imagen.
- La fórmula se escribe con CLAVES INTERNAS, no con etiquetas bonitas. La clave interna de un nombre es: todo en minúsculas, sin tildes, sin símbolos (como . % ( ) ), con espacios convertidos en guion bajo. Ejemplos: columna "Cant." → cant, columna "P. Unitario" → p_unitario, línea "ITBMS 7%" → itbms_7, línea "TOTAL A PAGAR" → total_a_pagar.
- Para usar la SUMA de una columna de la tabla escribe resumen_suma_ seguido de la clave de esa columna (ej. columna "Total" → resumen_suma_total; columna "Cant." → resumen_suma_cant).
- Para usar una línea del pie que aparece MÁS ARRIBA en el pie, escribe su clave sin prefijo (ej. subtotal, itbms_7). Nunca una línea que venga después.
- Los porcentajes van como decimal: 7% se escribe 0.07 (ej. subtotal * 0.07).
- Usa solo +, -, *, / y paréntesis. Si no estás seguro, deja formula_sugerida en null: el sistema la verifica contra los números de la imagen antes de usarla, así que no hay riesgo en sugerir, pero tampoco hay que forzar una que no se vea clara.

── FORMA "secciones" ──
Úsala cuando la imagen NO es una tabla de filas repetidas, sino un reporte con: (a) una o más estadísticas destacadas sueltas (ej. "CAPITAL: 11,142" arriba de todo), y (b) uno o más bloques con nombre propio (ej. "DETALLE", "CUADRO DE DEUDA ANTERIOR"), cada uno con sus propias líneas de etiqueta y valor — SIN que el bloque se repita varias veces.

Responde con este JSON exacto:
{
  "tipo": "secciones",
  "titulo": "texto del título principal, o null si no hay",
  "subtitulo": "una segunda línea debajo del título, como una fecha, o null si no hay",
  "estadisticas": [
    { "etiqueta": "Capital", "valor": 11142 }
  ],
  "secciones": [
    {
      "nombre": "DETALLE",
      "filas": [
        { "etiqueta": "Capital", "valor": 500, "formula_sugerida": null },
        { "etiqueta": "Interés", "valor": 1142, "formula_sugerida": null },
        { "etiqueta": "Nuevo saldo", "valor": 10642, "formula_sugerida": "resumen_capital - capital" }
      ]
    }
  ]
}

Reglas para "formula_sugerida" (SOLO aplica a la forma "secciones"):
- Para la MAYORÍA de las filas, esto es null — son datos crudos que se leen directo de la foto (ej. "Capital: 500" es un dato, no un cálculo).
- SOLO sugiere una fórmula cuando te parezca claro que un valor es el RESULTADO de sumar/restar otros valores YA LISTADOS más arriba en la imagen (ej. "Nuevo saldo" suele ser Capital menos Abono).
- La fórmula debe escribirse usando CLAVES INTERNAS, no las etiquetas bonitas. La clave interna de una etiqueta es: todo en minúsculas, sin tildes, sin símbolos como paréntesis o %, con espacios convertidos en guion bajo. Ejemplos: "Nuevo saldo" → nuevo_saldo, "Interés (10%)" → interes_10.
- Si el valor que quieres usar es una ESTADÍSTICA de las de arriba (fuera de cualquier sección), antepone "resumen_" a su clave: la estadística "Capital" se escribe "resumen_capital" dentro de una fórmula.
- Si el valor que quieres usar es una FILA de la MISMA sección, usa su clave SIN prefijo (ej. "capital"), y solo si esa fila ya apareció ANTES en la lista de esta misma sección (nunca una fila que viene después, y nunca una fila de OTRA sección).
- Si no estás seguro, o el cálculo no es obvio, deja formula_sugerida en null — es preferible un dato fijo a una fórmula adivinada; el sistema la verifica de todas formas antes de usarla, así que no hay riesgo en sugerir, pero tampoco hay que forzar una si no se ve clara.
- Usa solo +, -, *, / y paréntesis. No inventes funciones ni operadores.

── Reglas obligatorias para AMBAS formas ──
- Si una celda/valor es un número, ponlo como número de JSON (sin comillas, sin símbolo de moneda, sin comas de miles: 1500.75 y no "$1,500.75"). Si es texto, ponlo como texto entre comillas.
- Si un valor está en blanco: transcribe 0 si es numérico, o "" si es texto. NUNCA inventes un valor que no puedas ver con claridad.
- No agregues secciones, columnas ni filas que no estén en la imagen. No omitas ninguna fila real, aunque esté en blanco o en cero.
- Si no hay título o subtítulo visibles, usa null en esos dos campos.

Responde SOLO con el JSON, sin texto adicional antes ni después, sin \`\`\`.`;

/**
 * Interpreta el texto crudo que devolvió Groq (ya limpio de \`\`\`),
 * lo parsea como JSON, y valida/tipa la forma según extraido.tipo.
 * Separado de analizarFotoCuadro() para poder probarlo sin necesitar
 * la llamada de red a Groq.
 *
 * @returns {Object} para tipo 'tabla': { tipo, titulo, subtitulo, columnas, filas, filaTotales }
 *                   para tipo 'secciones': { tipo, titulo, subtitulo, estadisticas, secciones }
 */
export function interpretarRespuestaVision(textoCrudo) {
  if (!textoCrudo) throw new Error('Groq no devolvió contenido para esta imagen.');

  // Por si acaso viene envuelto en ```json ... ``` a pesar de haberlo pedido sin eso
  const limpio = textoCrudo.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let extraido;
  try {
    extraido = JSON.parse(limpio);
  } catch (e) {
    throw new Error('No pude interpretar la respuesta de Groq como JSON.');
  }

  // Si Groq no manda "tipo" (respuesta vieja, o se le olvidó), se asume
  // "tabla" — el comportamiento de siempre, para no romper nada.
  const tipo = extraido.tipo === 'secciones' ? 'secciones' : 'tabla';

  if (tipo === 'secciones') {
    if (!Array.isArray(extraido.secciones) || extraido.secciones.length === 0) {
      throw new Error('La respuesta no trae secciones reconocibles.');
    }
    return {
      tipo: 'secciones',
      titulo: extraido.titulo || null,
      subtitulo: extraido.subtitulo || null,
      estadisticas: Array.isArray(extraido.estadisticas)
        ? extraido.estadisticas.map(e => ({ etiqueta: e.etiqueta, valor: e.valor }))
        : [],
      secciones: extraido.secciones.map(s => ({
        nombre: s.nombre || 'Sección',
        filas: (Array.isArray(s.filas) ? s.filas : []).map(f => ({
          etiqueta: f.etiqueta,
          valor: f.valor,
          formula_sugerida: f.formula_sugerida || null,
        })),
      })),
    };
  }

  // tipo "tabla" — mismo comportamiento de siempre para columnas/filas/
  // filaTotales. "encabezado" y "pie" son opcionales (una tabla de
  // préstamos no los trae): si Groq no los manda, quedan como []. Aquí
  // solo se transcribe y se deja la forma limpia — nada se valida ni se
  // calcula (eso lo hace tablaExtendida.js). Un valor null se CONSERVA
  // tal cual: significa "no lo pude leer con seguridad", y más adelante
  // se trata como pendiente, nunca como 0.
  if (!Array.isArray(extraido.columnas) || extraido.columnas.length === 0) {
    throw new Error('La respuesta no trae columnas reconocibles.');
  }
  if (!Array.isArray(extraido.filas)) {
    throw new Error('La respuesta no trae filas reconocibles.');
  }
  return {
    tipo: 'tabla',
    titulo: extraido.titulo || null,
    subtitulo: extraido.subtitulo || null,
    encabezado: Array.isArray(extraido.encabezado)
      ? extraido.encabezado
          .filter(c => c && typeof c === 'object')
          .map(c => ({ etiqueta: c.etiqueta, valor: c.valor === undefined ? null : c.valor }))
      : [],
    columnas: extraido.columnas,
    filas: extraido.filas,
    filaTotales: extraido[FILA_TOTALES_ALIAS] || null,
    pie: Array.isArray(extraido.pie)
      ? extraido.pie
          .filter(c => c && typeof c === 'object')
          .map(c => ({
            etiqueta: c.etiqueta,
            valor: c.valor === undefined ? null : c.valor,
            formula_sugerida: c.formula_sugerida || null,
          }))
      : [],
  };
}

/**
 * Manda la imagen a Groq y devuelve el JSON ya parseado y tipado
 * (ver interpretarRespuestaVision). Lanza un Error con mensaje claro
 * si Groq no responde algo utilizable — el que llama a esta función
 * decide cómo avisarle al usuario.
 */
export async function analizarFotoCuadro(imageBytes, mimeType, groqApiKey) {
  const base64Imagen = bytesABase64(imageBytes);

  const respuesta = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'qwen/qwen3.8-27b',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Imagen}` } },
          { type: 'text', text: PROMPT_VISION },
        ],
      }],
      temperature: 0.1,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
      // "none" = respuesta rápida sin modo de razonamiento — igual que
      // usaba Kairós. Evita además el modo "thinking", donde este
      // modelo a veces manda toda la respuesta dentro de
      // reasoning_content en vez de content (ver defensa abajo).
      reasoning_effort: 'none',
    }),
  });

  const data = await respuesta.json();
  if (data.error) {
    const msg = data.error.message || '';
    const err = new Error(`Groq (visión): ${msg}`);
    // Un límite de uso/tokens del servicio NO significa que la foto sea
    // ilegible: quien llama debe avisar distinto ("reintenta en un rato").
    err.esLimiteDeUso = respuesta.status === 429 || respuesta.status === 413
      || /rate limit|too large|tokens per (minute|day)|OTPM|TPM|quota/i.test(msg);
    throw err;
  }

  const mensaje = data.choices?.[0]?.message;
  // Defensa: algunos servidores compatibles con OpenAI (y este modelo,
  // documentado) a veces mandan la respuesta completa en
  // reasoning_content en vez de content. Probamos los 3 campos, en orden.
  const textoCrudo = (mensaje?.content || mensaje?.reasoning_content || mensaje?.reasoning || '').trim();

  return interpretarRespuestaVision(textoCrudo);
}