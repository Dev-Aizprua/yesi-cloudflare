// functions/lib/ayuda.js
// Comando "ayuda" en código (sin Groq, 0 tokens): menú de lo que sabe hacer el bot y detalle por tema.
// Regla de seguridad: solo actúa si el mensaje es SOLO un pedido de ayuda ("ayuda", "qué puedes hacer",
// "ayuda inventario"); "ayúdame con la factura de Juan" NO cuenta y sigue por el flujo normal.

const sinTildes = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const plano = t => sinTildes(t)
  .replace(/[\p{Extended_Pictographic}‍️]/gu, ' ')
  .replace(/[¿?¡!.,;:"“”«»]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const RE_MENU = new RegExp('^(?:' + [
  '(?:(?:necesito|quiero|dame|dime|pido|muestrame|mostrame|ver)\\s+)?(?:la\\s+|el\\s+|las\\s+|mas\\s+)?(?:ayuda|menu|comandos|opciones|instrucciones|manual|help)(?:\\s+por favor|\\s+porfa)?',
  'que (?:puedes|sabes|podes|puede|haces|puedo) (?:hacer|decirte|pedirte|pedir|decir)(?: por mi| aqui)?',
  'que funciones (?:tienes|tiene)',
  'que (?:mas )?haces',
  'en que me (?:puedes|puede|podes) ayudar',
  'como (?:te uso|se usa|funciona(?: esto)?|uso esto|te utilizo)',
  'para que sirves',
  'que opciones (?:tengo|hay|tienes)',
  'que (?:comandos|cosas) (?:hay|tienes|puedo usar|puedo hacer)',
].join('|') + ')$');

// Tema → palabras que lo identifican (tras la palabra "ayuda").
const TEMAS = {
  ventas: /^(?:ventas?|gastos?|ventas y gastos|ventas gastos|vender|registrar ventas?)$/,
  fiados: /^(?:fiados?|fiar|cobros?|cobrar|deudas?|deudores|creditos?|cuentas por cobrar|quien me debe)$/,
  costos: /^(?:costos?|ganancias?|ganar|costos y ganancias?|margen|precios?)$/,
  inventario: /^(?:inventarios?|existencias?|stock|productos?)$/,
  reportes: /^(?:reportes?|informes?|resumenes?|resumen|balance|como va (?:el |mi )?negocio)$/,
  cuadros: /^(?:cuadros?|tablas?|excel|pdf|archivos?|fotos?)$/,
  documentos: /^(?:cotizaciones?|facturas?|proformas?|pagos?|documentos?)$/,
  prestamos: /^(?:prestamos?|abonos?|financistas?)$/,
  cartas: /^(?:cartas?|word|constancias?|plantillas?)$/,
  calculadora: /^(?:calculadoras?|calcular|calculos?|cuentas?|operaciones|sumas?|sumar|restas?|multiplicar|multiplicaciones|dividir|porcentajes?|itbms|impuestos?|matematicas?)$/,
};

/**
 * @param {string} texto
 * @returns {{ tema: string|null } | null}  tema null = menú general
 */
export function detectarAyuda(texto) {
  const t = plano(texto);
  if (!t || t.length > 60) return null;
  if (RE_MENU.test(t)) return { tema: null };
  const m = t.match(/^(?:ayuda|help|menu)(?: (?:con|de|sobre|para|en))?(?: (?:el|la|los|las|mi|mis|un|una))? (.+)$/);
  if (m) {
    const resto = m[1].trim();
    if (resto.split(' ').length <= 5) {
      for (const [tema, re] of Object.entries(TEMAS)) if (re.test(resto)) return { tema };
    }
  }
  // "ayuda <una o dos palabras>" que no es un tema conocido: se muestra el menú (en código) en vez de dejar que
  // Groq invente una guía. "ayuda con la factura de Juan" (más largo, con preposición) sigue por el flujo normal.
  const suelto = t.match(/^(?:ayuda|help|menu) ([a-z]+(?: [a-z]+)?)$/);
  if (suelto) return { tema: null, desconocido: suelto[1] };
  return null;
}

export const TEXTO_MENU = [
  '👋 Esto es lo que puedo hacer por tu negocio. Escríbeme como hablas, o mándame una nota de voz:',
  '',
  '💵 *Ventas y gastos* — "Vendí 2 panes a 1.50", "Pagué la luz 45"',
  '🤝 *Fiados y cobros* — "Vendí 3 jugos a crédito a Rosa", "Rosa pagó 2", "¿Quién me debe?"',
  '🏷️ *Costos y ganancia* — "El jugo cuesta: frutas 8, azúcar 2", "¿Cuánto gané este mes?"',
  '📦 *Inventario* — "Entraron 30 panes", "Me quedan 12 jugos", "Mi inventario"',
  '📊 *Reportes* — "¿Cómo va mi negocio este mes?", "Cómo me fue la semana pasada"',
  '📋 *Cuadros, Excel y PDF* — "Pásame el Excel del cuadro X", o mándame la foto de un cuadro',
  '🧾 *Cotizaciones, facturas y pagos* — "Hazme una cotización para Juan", "Juan pagó 100"',
  '💳 *Préstamos y abonos* — "Yisel abonó 10", "Cóbrale a Yisel"',
  '🧮 *Calculadora* — "25 por 18", "el 7% de 85", "120 más ITBMS"',
  '✉️ *Cartas en Word y PDF* — "Ayúdame con una carta" (te muestro las que tengo)',
  '',
  'Para ver más ejemplos de un tema escribe "ayuda" y el tema. Por ejemplo: "ayuda inventario".',
].join('\n');

const DETALLE = {
  ventas: [
    '💵 *Ventas y gastos*',
    '• "Vendí 2 panes a 1.50" (precio por unidad) o "Vendí 2 panes por 3 en total"',
    '• "Vendí 3 jugos a 2 a Ana" (guarda también el cliente)',
    '• "Pagué la luz 45" o "Compré hielo por 12"',
    '• "¿Cuánto vendí hoy / ayer / este mes?" y "¿cuánto gasté esta semana?"',
    '• "Anula la última venta" o "anula el último gasto"',
    'Siempre te muestro lo que voy a guardar y espero tu "sí".',
  ],
  fiados: [
    '🤝 *Fiados y cobros*',
    '• "Vendí 3 jugos a crédito a Rosa" (queda como fiado)',
    '• "Rosa pagó 2" para cobrar un fiado',
    '• "Anula el último cobro"',
    '• "¿Quién me debe?" (préstamos, facturas y fiados, con el total)',
    '• "Cóbrale a Rosa" o "dame la lista de cobros": te preparo un mensaje amable y un enlace para que tú lo envíes desde tu WhatsApp. Yo nunca le escribo a tus clientes.',
  ],
  costos: [
    '🏷️ *Costos y ganancia*',
    '• "El jugo cuesta: frutas 8, azúcar 2, envases 5" (costo de 1 unidad; si rinde varias, di "rinde 10")',
    '• "Mis costos" o "cuánto cuesta el jugo"',
    '• "¿Cuánto gané este mes?" (ventas menos el costo de la ficha; te aviso de lo que no tiene costo)',
    '• "Anula el costo del jugo"',
  ],
  inventario: [
    '📦 *Inventario*',
    '• "Entraron 30 panes" o "compré 30 panes": suma al inventario',
    '• "Me quedan 12 jugos" o "ajusta el inventario de jugos a 12": corrige el conteo',
    '• "Quita 8 jugos del inventario" o "Se vencieron 3 panes": descuenta esa cantidad',
    '• Si vendes varios sabores o tipos, registra cada uno por separado (ej. "Tengo 10 jugos de fresa" y "Tengo 6 jugos de mango").',
    '• "Avísame si quedan menos de 5 panes": mínimo para el aviso de stock bajo',
    '• "Mi inventario" o "¿cuánto me queda de jugos?"',
    '• Cada venta de un producto del inventario se descuenta sola. Nunca bloqueo una venta: solo te aviso si no alcanzaba.',
    '• "Anula la última entrada de panes"',
  ],
  reportes: [
    '📊 *Reportes*',
    '• "¿Cómo va mi negocio?" / "reporte de este mes" / "cómo me fue la semana pasada" / "ayer"',
    '• "Del 1 al 15 de octubre" o "entre el 10/10 y el 20/10"',
    '• "Compáralo con el mes pasado"',
    '• "Mándamelo en PDF"',
    'Incluye ventas y gastos, ganancia estimada, lo que te deben, inventario y los 3 productos más vendidos.',
  ],
  cuadros: [
    '📋 *Cuadros, Excel y PDF*',
    '• "Crea un cuadro de gastos con fecha, concepto y monto"',
    '• Mándame la foto de un cuadro y lo convierto en cuadro con Excel (te muestro lo leído y tú confirmas)',
    '• "Agrega a Pedro con monto 200" o "actualiza el abono de Ana a 50"',
    '• "Pásame el Excel del cuadro X" / "pásame el PDF del cuadro X"',
    '• "Elimina el cuadro X" (te pido confirmación)',
  ],
  documentos: [
    '🧾 *Cotizaciones, facturas y pagos*',
    '• "Hazme una cotización para Juan: 2 tornillos a 5 y 1 martillo a 12" (con ITBMS)',
    '• "Convierte la cotización 001 en factura proforma"',
    '• "Hazme la factura de Juan en PDF"',
    '• "Juan pagó 100" (te muestro el saldo antes y después, y espero tu "sí")',
    '• "Anula el último pago" o "anula la factura 003"',
    'Las facturas proforma son informativas; no son facturas fiscales.',
  ],
  prestamos: [
    '💳 *Préstamos y abonos*',
    '• "Yisel abonó 10" (se suma como abono, no se sobrescribe)',
    '• "Anula el último abono de Yisel"',
    '• "¿Quién me debe?" y "Cóbrale a Yisel"',
    '• "Pásame el Excel de préstamos"',
  ],
  calculadora: [
    '🧮 *Calculadora* (rápida y siempre exacta)',
    '• Operaciones: "25 por 18", "250 + 45", "cuánto es 100 entre 8", "suma 145, 230 y 75"',
    '• Porcentajes: "el 7% de 85", "85 más 10%", "85 menos el 10%"',
    '• ITBMS (7%): "120 más ITBMS", "107 sin ITBMS", "el ITBMS de 200"',
    '• Por voz también: "veinte por doce". Si el audio sale raro, dilo con números: "20 por 12".',
    'Solo funciona cuando todo el mensaje es el cálculo.',
  ],
  cartas: [
    '✉️ *Cartas en Word y PDF*',
    '• "Ayúdame con una carta": te muestro los tipos de carta que tengo y los datos que necesito de cada una.',
    '• Tengo: carta general (recomendación, aviso, agradecimiento, etc.), constancia de trabajo, recomendación laboral, renuncia, carta de cobro, poder simple y solicitud.',
    '• Por ejemplo, "Hazme una carta de cobro para Juan Pérez por 150 dólares" o "Hazme una constancia de trabajo".',
    '• Si me falta algún dato te lo pregunto, y te mando el documento en Word y también en PDF.',
  ],
};

export function textoAyuda(tema, desconocido = null) {
  if (!tema || !DETALLE[tema]) {
    return desconocido ? `No tengo una ayuda llamada "${desconocido}". Esto es lo que sí puedo hacer:\n\n${TEXTO_MENU}` : TEXTO_MENU;
  }
  return DETALLE[tema].join('\n') + '\n\nPara ver todo lo que puedo hacer escribe "ayuda".';
}