// GET: listar todas las plantillas disponibles
// POST: obtener plantilla personalizada con {nombre} y {rubro}

const PLANTILLAS = {

  // ─── 0. JOYERÍA / LUJO / MODA PREMIUM ───────────────────────
  joyeria: {
    key: 'joyeria',
    rubro: 'Joyería y Lujo',
    tono: 'premium',
    icono: '💎',
    asunto: '{nombre} — sus piezas merecen una vitrina digital a su altura',
    cuerpo: `Estimado equipo de {nombre},

Me comunico de parte de TechZone Panamá.

Una joya de $900 no se vende en una página genérica. Sus clientes evalúan la confianza antes de comprar — y esa confianza empieza en el primer segundo que ven su presencia digital.

Lo que TechZone construye para negocios de joyería y lujo:
✓ Tienda online con fotografía de alta resolución y detalles del producto
✓ Panel de ventas en tiempo real con métricas de ingresos y pedidos
✓ Carga en menos de 1 segundo — infraestructura Cloudflare de nivel corporativo
✓ Integración con Yappy y ACH para pagos locales
✓ Panel de control exclusivo para gestionar pedidos y entregas

Le invito a ver una demostración real de cómo funciona:
🔗 https://kairos-demo.pages.dev/

Es una simulación interactiva — en 60 segundos entenderá exactamente lo que estamos ofreciendo.

📱 Si prefiere hablar directamente, escríbanos por WhatsApp al +507 6016-4559.

Atentamente,
Eduardo Aizprua
TechZone Panamá
📧 eduardo.aizpruap@gmail.com`,
    whatsapp: `Hola equipo de {nombre} 👋

Soy Eduardo de TechZone Panamá. Vi su negocio y creo que sus piezas merecen una vitrina digital a su altura.

Construimos tiendas online premium con panel de ventas en tiempo real para joyerías en Panamá. Le preparé una demo interactiva:
🔗 https://kairos-demo.pages.dev/

¿Tienen 2 minutos para verla?`
  },

  // ─── 1. RESTAURANTES / COMIDA ────────────────────────────────
  restaurante: {
    key: 'restaurante',
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

💬 ¿Prefiere hablar directamente? Escríbanos por WhatsApp al +507 6016-4559 y le respondemos de inmediato.

Saludos,
Eduardo Aizprua
TechZone Panamá
📧 eduardo.aizpruap@gmail.com`,
    whatsapp: `Hola equipo de {nombre} 👋

Soy Eduardo de TechZone Panamá. ¿Sabían que PedidosYa y Uber Eats cobran hasta 35% de comisión por pedido?

Construimos sistemas de pedidos directos para restaurantes — sin comisiones, todo para ustedes. ¿Les interesa saber cómo funciona?`
  },

  // ─── 2. CLÍNICAS / ODONTOLOGÍA ───────────────────────────────
  odontologia: {
    key: 'odontologia',
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

📱 Si prefiere una respuesta más rápida, puede contactarnos por WhatsApp al +507 6016-4559 — atendemos de lunes a sábado.

Atentamente,
Eduardo Aizprua
TechZone Panamá
📧 eduardo.aizpruap@gmail.com`,
    whatsapp: `Hola equipo de {nombre} 👋

Soy Eduardo de TechZone Panamá. Trabajamos con clínicas en Panamá para que los pacientes puedan agendar citas online 24/7, sin llamadas perdidas.

¿Les interesa una demo rápida de cómo funciona?`
  },

  // ─── 3. TIENDAS / RETAIL ─────────────────────────────────────
  retail: {
    key: 'retail',
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

💬 ¿Prefiere hablar directamente? Escríbanos por WhatsApp al +507 6016-4559 y le respondemos de inmediato.

Saludos,
Eduardo Aizprua
TechZone Panamá
📧 eduardo.aizpruap@gmail.com`,
    whatsapp: `Hola equipo de {nombre} 👋

Soy Eduardo de TechZone Panamá. ¿Cuántos mensajes de "¿precio?" responden al día por WhatsApp?

Una tienda online resuelve eso y libera ese tiempo para vender más. ¿Le muestro cómo?`
  },

  // ─── 4. SERVICIOS PROFESIONALES ──────────────────────────────
  servicios_profesionales: {
    key: 'servicios_profesionales',
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

📱 Si prefiere una respuesta más rápida, puede contactarnos por WhatsApp al +507 6016-4559 — atendemos de lunes a sábado.

Atentamente,
Eduardo Aizprua
TechZone Panamá
📧 eduardo.aizpruap@gmail.com`,
    whatsapp: `Hola {nombre} 👋

Soy Eduardo de TechZone. En Panamá, los profesionales que tienen presencia digital bien hecha reciben 3x más consultas que los que dependen solo del boca a boca.

¿Le interesa ver opciones concretas para su perfil?`
  },

  // ─── 6. SEGUIMIENTO — VALOR Y PRUEBA SOCIAL ──────────────────
  seguimiento_valor: {
    key: 'seguimiento_valor',
    rubro: 'Seguimiento',
    tono: 'conversacional',
    icono: '🔁',
    asunto: 'Re: Propuesta de TechZone para {nombre} — un dato que olvidé mencionar',
    cuerpo: `Hola de nuevo equipo de {nombre},

Espero que estén teniendo una excelente semana.

Solo pasaba por aquí para compartirles un dato que olvidé mencionar en mi correo anterior sobre {rubro}: Los negocios en Panamá que implementan un sistema de pedidos directos logran aumentar su margen de ganancia neta entre un 15% y un 25% desde el primer mes, simplemente eliminando las comisiones de terceros.

Me gustaría mucho que {nombre} fuera el próximo caso de éxito. ¿Pudieron revisar la propuesta que les envié o tienen alguna duda técnica que podamos resolver en una llamada de 5 minutos?

Quedo atento a su respuesta.

💬 ¿Prefiere hablar directamente? Escríbanos por WhatsApp al +507 6016-4559 y le respondemos de inmediato.

Saludos,
Eduardo Aizprua
TechZone Panamá
📧 eduardo.aizpruap@gmail.com`,
    whatsapp: `Hola de nuevo equipo de {nombre} 👋

Solo para comentarles: los negocios en Panamá que implementan pedidos directos mejoran su margen entre 15-25% desde el primer mes, sin comisiones de terceros.

Pudieron revisar la propuesta? Tienen alguna duda que pueda resolver?`
  },

  // ─── 7. SEGUIMIENTO — PEZ GORDO (DIRECTO A WHATSAPP) ─────────
  seguimiento_pez_gordo: {
    key: 'seguimiento_pez_gordo',
    rubro: 'Seguimiento Ejecutivo',
    tono: 'directo',
    icono: '🐋',
    asunto: '¿Alguna duda con la estrategia para {nombre}?',
    cuerpo: `Hola {nombre},

Te escribo brevemente porque entiendo que tu agenda debe estar a tope.

Sigo muy interesado en que trabajemos juntos para optimizar los procesos digitales de tu negocio. He reservado un espacio en mi agenda para mañana por si prefieres que te explique los beneficios de TechZone de forma más directa.

Si te resulta más cómodo, puedes escribirme o enviarme un audio por WhatsApp al +507 6016-4559 y lo coordinamos de inmediato.

Quedo a la espera de tus noticias para dar el siguiente paso.

Saludos,
Eduardo Aizprua
TechZone Panamá
📧 eduardo.aizpruap@gmail.com`,
    whatsapp: `Hola {nombre} 👋

Te escribo brevemente, entiendo que tienes la agenda ocupada.

Tienes 5 minutos esta semana para una llamada rapida? Creo que puedo aportarle valor real a tu negocio. También puedes responderme por aquí. 📲`
  },

  // ─── 5. MULTISERVICIOS / OTROS ───────────────────────────────
  multiservicios: {
    key: 'multiservicios',
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

💬 ¿Prefiere hablar directamente? Escríbanos por WhatsApp al +507 6016-4559 y le respondemos de inmediato.

Saludos,
Eduardo Aizprua
TechZone Panamá
📧 eduardo.aizpruap@gmail.com`,
    whatsapp: `Hola equipo de {nombre} 👋

Soy Eduardo de TechZone Panamá. Vi su negocio en Google Maps y creo que hay clientes buscándoles ahora mismo que no los están encontrando.

¿Tiene 2 minutos para ver cómo lo resolvemos?`
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

  if (/joyeria|joya|diamante|oro|plata|bisuteria|lujo|luxury|reloj|accesorio/.test(r))
    return PLANTILLAS.joyeria;

  if (/tienda|retail|ropa|electronica|moda|boutique|ferreteria|supermercado|shop/.test(r))
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

    // Falla 1 — fallback para asunto/cuerpo si una plantilla futura los omite
    const asuntoRaw = plantilla.asunto || 'Propuesta Digital para {nombre} — TechZone Panamá';
    const cuerpoRaw = plantilla.cuerpo || 'Hola equipo de {nombre}, soy Eduardo de TechZone Panamá. Me gustaría presentarles una propuesta digital para su negocio. Escríbanos al +507 6016-4559.';
    const whatsappRaw = plantilla.whatsapp || 'Hola equipo de {nombre} 👋\n\nSoy Eduardo de TechZone Panamá. ¿Tienen 2 minutos para ver cómo podemos llevar su negocio al siguiente nivel digital?\n\n🔗 https://kairos-demo.pages.dev/';

    // Falla 5 — sanitizar nombre para que caracteres especiales no rompan links de WhatsApp
    const nombreSeguro = nombreFinal.replace(/[&<>"'#%+]/g, (c) => encodeURIComponent(c));

    const asunto = asuntoRaw
      .replace(/\{nombre\}/g, nombreFinal)
      .replace(/\{rubro\}/g, rubroFinal);

    const cuerpo = cuerpoRaw
      .replace(/\{nombre\}/g, nombreFinal)
      .replace(/\{rubro\}/g, rubroFinal);

    const whatsapp = whatsappRaw
      .replace(/\{nombre\}/g, nombreFinal)
      .replace(/\{rubro\}/g, rubroFinal);

    // Link de WhatsApp seguro con nombre codificado
    const whatsappLink = `https://wa.me/50760164559?text=${encodeURIComponent(`Hola Eduardo, soy ${nombreSeguro} y me interesa saber más sobre TechZone.`)}`;

    return Response.json({
      success: true,
      plantilla: plantilla.key || key || 'multiservicios',
      rubro: plantilla.rubro || 'General',
      tono: plantilla.tono || 'conversacional',
      icono: plantilla.icono || '✨',
      asunto,
      cuerpo,
      whatsapp,
      whatsappLink
    });

  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}