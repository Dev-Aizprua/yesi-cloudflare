// GET: listar todas las plantillas disponibles
// POST: obtener plantilla personalizada con {nombre} y {rubro}

const PLANTILLAS = {

  // ─── 1. RESTAURANTES / COMIDA ────────────────────────────────
  restaurante: {
    rubro: 'Restaurante',
    tono: 'conversacional',
    icono: '🍕',
    asunto: '{nombre} — ¿cuánto le están cobrando de comisión hoy?',
    cuerpo: `Hola equipo de {nombre},

Mi nombre es Eduardo Aizprua, de TechZone Panamá.

Vi su restaurante en Google Maps y noté que tienen muy buenas reseñas. Eso me dice que la comida es excelente — el problema es que probablemente PedidosYa o Uber Eats se están quedando con entre el 25% y el 35% de cada pedido que llega por esas apps.

Eso es dinero que debería quedarse en su restaurante.

En TechZone construimos tiendas web con pedidos directos para restaurantes panameños:
✓ Menú digital actualizable en minutos
✓ Pedidos directos por WhatsApp sin intermediarios
✓ Sistema de reservaciones online 24/7
✓ Cero comisiones — los pedidos llegan directo a ustedes

¿Tienen 15 minutos esta semana para una llamada rápida? Puedo mostrarles exactamente cuánto pueden ahorrar al mes.

Saludos,
Eduardo Aizprua
TechZone Panamá
📧 eduardo.aizpruap@gmail.com`
  },

  // ─── 2. CLÍNICAS / ODONTOLOGÍA ───────────────────────────────
  odontologia: {
    rubro: 'Odontología',
    tono: 'formal',
    icono: '🦷',
    asunto: 'Propuesta de Presencia Digital para {nombre}',
    cuerpo: `Estimado equipo de {nombre},

Me dirijo a ustedes de parte de TechZone Panamá.

En el sector salud privado de Panamá, la primera impresión ya no ocurre en la sala de espera — ocurre en Google. Un paciente potencial busca "{rubro} cerca de mí" y elige la clínica que transmite más confianza en los primeros 10 segundos.

El proceso de agendar una cita por teléfono o WhatsApp genera pérdidas silenciosas: llamadas sin respuesta, mensajes a las 11pm que nadie contesta, pacientes que simplemente eligen otra clínica.

Lo que TechZone ofrece para clínicas como {nombre}:
✓ Sitio web profesional que proyecta autoridad y confianza
✓ Sistema de citas online disponible 24/7
✓ Ficha de cada doctor con especialidad y experiencia
✓ Integración con WhatsApp para confirmaciones automáticas

Estaré encantado de presentarles una propuesta personalizada sin ningún compromiso.

Atentamente,
Eduardo Aizprua
TechZone Panamá
📧 eduardo.aizpruap@gmail.com`
  },

  // ─── 3. TIENDAS / RETAIL ─────────────────────────────────────
  retail: {
    rubro: 'Retail',
    tono: 'conversacional',
    icono: '🛍️',
    asunto: '{nombre} — sus clientes preguntan "¿precio?" por WhatsApp todo el día, ¿verdad?',
    cuerpo: `Hola equipo de {nombre},

Soy Eduardo de TechZone Panamá.

Sé que el día a día de una tienda en Panamá incluye responder decenas de mensajes de WhatsApp con la misma pregunta: "¿Tienen esto? ¿Cuánto cuesta? ¿Hacen envíos?"

Eso consume horas que podrían dedicarse a vender.

Una tienda online profesional resuelve esto de una vez:
✓ Catálogo completo con precios visible 24/7
✓ El cliente ve, elige y paga — sin preguntar
✓ Sincronización automática con su inventario
✓ Carrito de compras con pago en línea o contra entrega
✓ Sus productos aparecen en Google cuando alguien busca lo que venden

En TechZone hemos construido tiendas online para negocios en Panamá que duplicaron sus ventas en los primeros 3 meses.

¿Conversamos esta semana?

Saludos,
Eduardo Aizprua
TechZone Panamá
📧 eduardo.aizpruap@gmail.com`
  },

  // ─── 4. SERVICIOS PROFESIONALES ──────────────────────────────
  servicios_profesionales: {
    rubro: 'Servicios Profesionales',
    tono: 'formal',
    icono: '⚖️',
    asunto: 'Su reputación profesional merece una presencia digital a la altura — {nombre}',
    cuerpo: `Estimado(a) {nombre},

Me comunico de parte de TechZone Panamá.

En un mercado tan competitivo como el de los servicios profesionales en Panamá, los clientes investigan antes de contratar. Buscan en Google, evalúan la presencia digital y toman decisiones basadas en la confianza que proyecta el profesional en línea.

Un perfil de Google Maps, por más reseñas que tenga, no es suficiente para transmitir la autoridad y experiencia que usted ha construido a lo largo de su carrera.

TechZone diseña landing pages profesionales para abogados, contadores y consultores que:
✓ Posicionan su nombre y especialidad en Google
✓ Presentan su trayectoria y casos de éxito
✓ Incluyen formulario de contacto y consulta inicial
✓ Generan confianza desde el primer clic

Le propongo una reunión breve para presentarle opciones concretas adaptadas a su perfil profesional.

Atentamente,
Eduardo Aizprua
TechZone Panamá
📧 eduardo.aizpruap@gmail.com`
  },

  // ─── 6. SEGUIMIENTO — VALOR Y PRUEBA SOCIAL ──────────────────
  seguimiento_valor: {
    rubro: 'Seguimiento',
    tono: 'conversacional',
    icono: '🔁',
    asunto: 'Re: Propuesta de TechZone para {nombre} — un dato que olvidé mencionar',
    cuerpo: `Hola de nuevo equipo de {nombre},

Espero que estén teniendo una excelente semana.

Solo pasaba por aquí para compartirles un dato que olvidé mencionar en mi correo anterior sobre {rubro}: Los negocios en Panamá que implementan un sistema de pedidos directos logran aumentar su margen de ganancia neta entre un 15% y un 25% desde el primer mes, simplemente eliminando las comisiones de terceros.

Me gustaría mucho que {nombre} fuera el próximo caso de éxito. ¿Pudieron revisar la propuesta que les envié o tienen alguna duda técnica que podamos resolver en una llamada de 5 minutos?

Quedo atento a su respuesta.

Saludos,
Eduardo Aizprua
TechZone Panamá
📧 eduardo.aizpruap@gmail.com`
  },

  // ─── 7. SEGUIMIENTO — PEZ GORDO (DIRECTO A WHATSAPP) ─────────
  seguimiento_pez_gordo: {
    rubro: 'Seguimiento Ejecutivo',
    tono: 'directo',
    icono: '🐋',
    asunto: '¿Alguna duda con la estrategia para {nombre}?',
    cuerpo: `Hola {nombre},

Te escribo brevemente porque entiendo que tu agenda debe estar a tope.

Sigo muy interesado en que trabajemos juntos para optimizar los procesos digitales de tu negocio. He reservado un espacio en mi agenda para mañana por si prefieres que te explique los beneficios de TechZone de forma más directa.

Si te resulta más cómodo, puedes escribirme o enviarme un audio por WhatsApp al +507-6423-0862 y lo coordinamos por allá en un momento.

Quedo a la espera de tus noticias para dar el siguiente paso.

Saludos,
Eduardo Aizprua
TechZone Panamá
📧 eduardo.aizpruap@gmail.com`
  },

  // ─── 5. MULTISERVICIOS / OTROS ───────────────────────────────
  multiservicios: {
    rubro: 'Multiservicios',
    tono: 'conversacional',
    icono: '✨',
    asunto: '{nombre} — hay clientes buscándoles en Google ahora mismo',
    cuerpo: `Hola equipo de {nombre},

Soy Eduardo de TechZone Panamá.

Encontré su negocio en Google Maps y noté que tienen buenas reseñas — eso me dice que hacen un buen trabajo. El problema es que muchos clientes potenciales los buscan en Google y si no encuentran un sitio web, simplemente llaman al siguiente resultado.

En Panamá, tener presencia digital ya no es un lujo — es lo que separa a los negocios que crecen de los que se quedan estancados.

TechZone construye sitios web profesionales para negocios como el suyo:
✓ Página web que aparece en Google cuando buscan sus servicios
✓ Información clara: qué hacen, dónde están, cómo contactarlos
✓ Galería de trabajos o servicios
✓ Botón directo de WhatsApp para consultas
✓ Precio accesible, sin mensualidades

¿Les interesa saber más? Una llamada de 15 minutos es suficiente para contarles todo.

Saludos,
Eduardo Aizprua
TechZone Panamá
📧 eduardo.aizpruap@gmail.com`
  }
};

// Función para detectar plantilla según rubro
function detectarPlantilla(rubro) {
  if (!rubro) return PLANTILLAS.multiservicios;

  const r = rubro.toLowerCase();

  if (/restaurante|comida|cafeteria|cafe|bar|pizza|sushi|parrilla|mariscos|cocina|food/.test(r))
    return PLANTILLAS.restaurante;

  if (/dental|odontologo|clinica|medico|salud|farmacia|doctor|hospital|consulta|ortodoncia/.test(r))
    return PLANTILLAS.odontologia;

  if (/tienda|retail|ropa|joyeria|electronica|moda|boutique|ferreteria|supermercado|shop/.test(r))
    return PLANTILLAS.retail;

  if (/abogado|contador|consultor|juridico|legal|contabilidad|auditoria|notaria|arquitecto|ingeniero/.test(r))
    return PLANTILLAS.servicios_profesionales;

  return PLANTILLAS.multiservicios;
}

// GET: listar todas las plantillas
export async function onRequestGet(context) {
  const plantillasResumen = Object.entries(PLANTILLAS).map(([key, p]) => ({
    key,
    rubro: p.rubro,
    tono: p.tono,
    icono: p.icono,
    asunto_preview: p.asunto.substring(0, 60) + '...'
  }));

  return Response.json({ success: true, plantillas: plantillasResumen });
}

// POST: obtener plantilla personalizada
export async function onRequestPost(context) {
  const { request } = context;

  try {
    const { nombre, rubro, key } = await request.json();

    // Seleccionar plantilla por key o por rubro
    let plantilla = key ? PLANTILLAS[key] : detectarPlantilla(rubro);
    if (!plantilla) plantilla = PLANTILLAS.multiservicios;

    // Personalizar con nombre y rubro
    const nombreFinal = nombre || 'su negocio';
    const rubroFinal = rubro || plantilla.rubro;

    const asunto = plantilla.asunto
      .replace(/\{nombre\}/g, nombreFinal)
      .replace(/\{rubro\}/g, rubroFinal);

    const cuerpo = plantilla.cuerpo
      .replace(/\{nombre\}/g, nombreFinal)
      .replace(/\{rubro\}/g, rubroFinal);

    return Response.json({
      success: true,
      plantilla: plantilla.key,
      rubro: plantilla.rubro,
      tono: plantilla.tono,
      icono: plantilla.icono,
      asunto,
      cuerpo
    });

  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}