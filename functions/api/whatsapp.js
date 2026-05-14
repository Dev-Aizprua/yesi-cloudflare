// KAIRÓS — WhatsApp Business API
// Fase 5B: Cerebro Groq + Memoria D1 + Lógica de Ventas

const VERIFY_TOKEN = "KAIROS_WA_2026";

// ─── VERIFICACIÓN DEL WEBHOOK (GET) ──────────────────────────────
export async function onRequestGet(context) {
  const { searchParams } = new URL(context.request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Error de verificación", { status: 403 });
}

// ─── RECEPCIÓN DE MENSAJES (POST) ────────────────────────────────
export async function onRequestPost(context) {
  const { env } = context;

  try {
    const body = await context.request.json();

    if (body.object !== "whatsapp_business_account") {
      return new Response("No es WhatsApp", { status: 200 });
    }

    const value = body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message) return new Response("EVENT_RECEIVED", { status: 200 });

    const from = message.from;
    const tipo = message.type;

    // ─── MANEJO DE AUDIO CON GROQ WHISPER ────────────────────
    if (tipo === "audio") {
      const audioId = message.audio?.id;
      const duracion = message.audio?.duration || 0;

      // Audio largo (>20s) — Eduardo toma el control
      if (duracion > 20) {
        await enviarMensaje(env, from, "Don, recibí su audio. Lo escucharé personalmente para no perder detalles y le escribo en breve. 🎧");
        try {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: env.TELEGRAM_CHAT_ID,
              text: `🎙️ <b>Audio largo en WhatsApp</b>\n\nDe: +${from}\nDuración: ${duracion}s\n\n⚠️ Requiere tu atención personal para cerrar la venta.`,
              parse_mode: "HTML"
            })
          });
        } catch(e) {}
        return new Response("EVENT_RECEIVED", { status: 200 });
      }

      // Audio corto (<20s) — transcribir con Groq Whisper
      try {
        // 1. Obtener URL del audio desde Meta
        const mediaRes = await fetch(`https://graph.facebook.com/v21.0/${audioId}`, {
          headers: { "Authorization": `Bearer ${env.WHATSAPP_TOKEN}` }
        });
        const mediaData = await mediaRes.json();
        const audioUrl = mediaData.url;

        // 2. Descargar el audio
        const audioRes = await fetch(audioUrl, {
          headers: { "Authorization": `Bearer ${env.WHATSAPP_TOKEN}` }
        });
        const audioBlob = await audioRes.arrayBuffer();

        // 3. Enviar a Groq Whisper para transcripción
        const formData = new FormData();
        formData.append("file", new Blob([audioBlob], { type: "audio/ogg" }), "audio.ogg");
        formData.append("model", "whisper-large-v3");
        formData.append("language", "es");

        const whisperRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.GROQ_API_KEY_PRO || env.GROQ_API_KEY}` },
          body: formData
        });

        const whisperData = await whisperRes.json();
        const transcripcion = whisperData.text || "";

        console.log(`Audio transcrito: ${transcripcion}`);

        if (!transcripcion) {
          await enviarMensaje(env, from, "No pude entender bien el audio. ¿Puede escribirme su consulta?");
          return new Response("EVENT_RECEIVED", { status: 200 });
        }

        // 4. Procesar la transcripción como si fuera texto
        // Notificar Telegram con transcripción
        try {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: env.TELEGRAM_CHAT_ID,
              text: `🎤 <b>Audio transcrito</b>\n\nDe: +${from}\n📝 "${transcripcion}"`,
              parse_mode: "HTML"
            })
          });
        } catch(e) {}

        // Continuar con la transcripción como texto
        message.text = { body: transcripcion };
        message.type = "text";

      } catch(e) {
        console.log("Error transcribiendo audio:", e.message);
        await enviarMensaje(env, from, "No pude procesar el audio. ¿Puede escribirme su consulta?");
        return new Response("EVENT_RECEIVED", { status: 200 });
      }
    }

    // ─── MANEJO DE IMÁGENES CON LLAMA 4 SCOUT ────────────────
    let contextoVisual = '';
    if (tipo === "image") {
      const imageId = message.image?.id;
      const caption = message.image?.caption || '';

      try {
        // 1. Obtener URL de la imagen desde Meta
        const mediaRes = await fetch(`https://graph.facebook.com/v21.0/${imageId}`, {
          headers: { "Authorization": `Bearer ${env.WHATSAPP_TOKEN}` }
        });
        const mediaData = await mediaRes.json();
        const imageUrl = mediaData.url;

        // 2. Descargar la imagen
        const imageRes = await fetch(imageUrl, {
          headers: { "Authorization": `Bearer ${env.WHATSAPP_TOKEN}` }
        });
        const imageBuffer = await imageRes.arrayBuffer();
        const base64Image = btoa(String.fromCharCode(...new Uint8Array(imageBuffer)));
        const mimeType = mediaData.mime_type || "image/jpeg";

        // 3. Analizar con LLaMA 4 Scout (visión)
        const visionRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.GROQ_VISION_API_KEY || env.GROQ_API_KEY_PRO || env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "meta-llama/llama-4-scout-17b-16e-instruct",
            messages: [{
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: `data:${mimeType};base64,${base64Image}` }
                },
                {
                  type: "text",
                  text: `Eres un analista de ventas experto. Analiza esta imagen y extrae ESPECÍFICAMENTE:
1. Si es un sitio web o captura de pantalla: precios visibles, servicios ofrecidos, errores de diseño o usabilidad
2. Si es un negocio o local: tipo de negocio, productos visibles, oportunidades de mejora digital
3. Si es competencia: precios, servicios, ventajas y debilidades vs TechZone Panamá
Responde en español de forma concisa. Máximo 5 líneas. Contexto adicional del cliente: "${caption}"`
                }
              ]
            }],
            temperature: 0.1,
            max_tokens: 400
          })
        });

        const visionData = await visionRes.json();
        const analisis = visionData.choices?.[0]?.message?.content || '';

        if (analisis) {
          contextoVisual = `\n\n📸 CONTEXTO VISUAL (análisis de imagen enviada por el cliente):\n${analisis}\nUSA este contexto para personalizar tu respuesta de ventas.`;

          // Notificar Telegram con el análisis
          try {
            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: env.TELEGRAM_CHAT_ID,
                text: `👁️ <b>Imagen analizada — WhatsApp</b>\n\nDe: +${from}\n📝 Análisis: ${analisis}`,
                parse_mode: "HTML"
              })
            });
          } catch(e) {}

          // Guardar análisis en D1
          try {
            await env.kairos_db.prepare(
              "INSERT INTO Conversaciones_WA (numero, rol, contenido, fecha) VALUES (?, ?, ?, ?)"
            ).bind(from, "user", `[Imagen analizada] ${analisis}`, new Date().toISOString()).run();
          } catch(e) {}
        }

        // Continuar flujo con texto vacío + contexto visual
        message.text = { body: caption || "El cliente envió una imagen." };
        message.type = "text";

      } catch(e) {
        console.log("Error analizando imagen:", e.message);
        await enviarMensaje(env, from, "Recibí tu imagen. ¿Puedes contarme más sobre lo que necesitas?");
        return new Response("EVENT_RECEIVED", { status: 200 });
      }
    }

    // ─── OTROS TIPOS (video, documento, etc.) ────────────────
    if (tipo !== "text" && tipo !== "audio" && tipo !== "image") {
      await enviarMensaje(env, from, "Recibí tu mensaje. Por ahora proceso texto, audios e imágenes. ¿En qué puedo ayudarte?");
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    const textoRecibido = message.text?.body || "";
    // Si hay contexto visual, enriquece el texto del buffer
    const textoBuffer = contextoVisual
      ? `${textoRecibido} [Imagen analizada: ${contextoVisual.replace(/\n/g, ' ')}]`
      : textoRecibido;
    console.log(`Mensaje de ${from}: ${textoBuffer}`);

    // ─── DEBOUNCE — AGRUPAR MENSAJES MÚLTIPLES ───────────────
    // Guardar mensaje en buffer D1
    const fechaBuffer = new Date().toISOString();
    let miId = null;
    try {
      const insertResult = await env.kairos_db.prepare(
        "INSERT INTO Buffer_WA (numero, contenido, fecha, procesado) VALUES (?, ?, ?, 0)"
      ).bind(from, textoBuffer, fechaBuffer).run();
      miId = insertResult.meta?.last_row_id;
    } catch(e) {
      console.log("Error buffer:", e.message);
    }

    // Esperar 8 segundos — ventana de silencio
    await new Promise(r => setTimeout(r, 8000));

    // Verificar si llegaron más mensajes después de este
    let mensajesBuffer = [];
    try {
      const bufferResult = await env.kairos_db.prepare(
        "SELECT id, contenido FROM Buffer_WA WHERE numero = ? AND procesado = 0 ORDER BY id ASC"
      ).bind(from).all();
      mensajesBuffer = bufferResult.results || [];
    } catch(e) {
      console.log("Error leyendo buffer:", e.message);
      mensajesBuffer = [{ contenido: textoRecibido }];
    }

    // Si no hay mensajes pendientes — ya fue procesado por otra instancia
    if (mensajesBuffer.length === 0) {
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    // ─── LOCK: solo el primer mensaje (id más bajo) procesa ───
    const primerIdPendiente = mensajesBuffer[0].id;
    if (miId && miId !== primerIdPendiente) {
      // Esta instancia no es la primera — ceder el control
      console.log(`Instancia ${miId} cede control a instancia ${primerIdPendiente}`);
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    // Consolidar todos los mensajes en uno
    const textoConsolidado = mensajesBuffer.map(m => m.contenido).join(" ");
    const idsBuffer = mensajesBuffer.map(m => m.id);
    const msgId = idsBuffer[idsBuffer.length - 1] || null; // último mensaje para doble check azul

    // Marcar como procesados ANTES de responder — evita duplicados
    try {
      await env.kairos_db.prepare(
        `UPDATE Buffer_WA SET procesado = 1 WHERE id IN (${idsBuffer.join(",")})`
      ).run();
    } catch(e) {
      console.log("Error marcando buffer:", e.message);
    }

    console.log(`Texto consolidado (${mensajesBuffer.length} msgs): ${textoConsolidado}`);

    // ─── CARGAR HISTORIAL Y NOMBRE DEL LEAD ──────────────────
    let historial = [];
    let nombreLead = null;
    try {
      const result = await env.kairos_db.prepare(
        "SELECT rol, contenido FROM Conversaciones_WA WHERE numero = ? ORDER BY id DESC LIMIT 20"
      ).bind(from).all();
      historial = (result.results || []).reverse().map(r => ({
        role: r.rol,
        content: r.contenido
      }));
    } catch(e) {
      console.log("Sin historial:", e.message);
    }

    // Consultar si el número está registrado como prospecto en D1
    try {
      const leadResult = await env.kairos_db.prepare(
        "SELECT nombre FROM Prospectos WHERE whatsapp LIKE ? OR whatsapp LIKE ? LIMIT 1"
      ).bind(`%${from}%`, `+${from}`).all();
      if (leadResult.results?.length > 0) {
        nombreLead = leadResult.results[0].nombre;
        console.log(`Lead identificado: ${nombreLead}`);
      }
    } catch(e) {
      console.log("Sin lead registrado:", e.message);
    }

    // ─── DETECTAR ETAPA DEL CLIENTE EN EL EMBUDO ─────────────
    // Analiza el historial para determinar en qué fase está el prospecto
    const historialTexto = historial.map(h => h.content).join(" ").toLowerCase();
    const yaVioPDF      = historialTexto.includes("propuesta_techzone") || historialTexto.includes("pdf") || historialTexto.includes("350");
    const yaRecibioPrecios = historialTexto.includes("350") || historialTexto.includes("propuesta_techzone") || historialTexto.includes("activación");
    const esPrimerMensaje  = historial.length === 0;
    const textoLower       = textoConsolidado.toLowerCase();

    // Señales de compra — palabras que indican intención real
    const senalesCompra = ["me interesa", "quiero", "cuándo empezamos", "cómo pago", "yappy", "ach",
      "cuánto cuesta", "precio", "costo", "inversión", "arrancar", "empezar", "contratar",
      "cuántos días", "qué incluye", "adelante", "hagámoslo", "vamos", "perfecto", "excelente",
      "me convence", "lo quiero", "cuándo pueden", "disponible"].some(s => textoLower.includes(s));

    // Interés específico en cada producto
    const interesaTienda   = ["tienda", "ecommerce", "e-commerce", "catálogo", "carrito", "inventario",
      "producto a", "elegance", "tienda completa"].some(s => textoLower.includes(s));
    const interesaLanding  = ["landing", "página de ventas", "estacional", "navidad", "san valentín",
      "fiestas patrias", "colores", "temporada", "producto b", "landing page"].some(s => textoLower.includes(s));
    const quiereAmbos      = ["los dos", "ambos", "los 2", "quiero los dos", "me interesan los dos",
      "los dos productos", "ambos productos"].some(s => textoLower.includes(s));

    // Señales de pago inmediato — cliente listo para transferir ahora
    const listoParaPagar = ["listo para pagar", "cómo pago", "número de yappy", "cuenta ach",
      "qué cuenta", "a dónde transfiero", "cómo hago el pago", "pago ahora",
      "cuándo pago", "acepta yappy", "mandarle el pago"].some(s => textoLower.includes(s));

    // Señales de decisor/dueño — eleva el lenguaje a ROI e inversión
    const esDueno = ["mi negocio", "yo manejo", "soy el dueño", "soy la dueña", "yo decido",
      "tengo un negocio", "mi tienda", "mi empresa", "yo administro", "a mi cargo",
      "somos familia", "negocio familiar", "llevo", "años en el negocio"].some(s => textoLower.includes(s));

    // Señales de objeción — para activar contra-argumento correcto
    const objecionPrecio  = ["caro", "costoso", "mucho", "no tengo", "presupuesto", "económico", "barato", "descuento"].some(s => textoLower.includes(s));
    const objecionTiempo  = ["mucho tiempo", "tarde", "rápido", "urgente", "pronto", "demora"].some(s => textoLower.includes(s));
    const objecionConfianza = ["seguro", "garantía", "confiar", "funciona", "resultados", "comprobado"].some(s => textoLower.includes(s));
    const quiereLlamar    = ["llamada", "llamar", "hablar", "teléfono", "reunión", "zoom", "meet"].some(s => textoLower.includes(s));

    // Señales de rechazo — despedida cordial sin más preguntas
    // esRechazo solo aplica al mensaje ACTUAL — no al historial
    const esRechazo = ["no me interesa", "no gracias", "no quiero", "no estoy interesado",
      "no estoy interesada", "no por ahora", "déjame tranquilo",
      "no molestes", "retírese", "no contactar", "quíteme", "borre mi número"].some(s => textoLower.includes(s));

    const saludo = nombreLead
      ? `Hola ${nombreLead}, un gusto saludarle. Soy Kairós, asesor digital de TechZone Panamá. He analizado el impacto que podríamos tener en su sector y preparé algo especial para usted. ¿Me permite mostrárselo?`
      : `Hola, un gusto saludarle. Soy Kairós, asesor digital de TechZone Panamá. ¿En qué tipo de negocio está usted?`;

    // ─── MENSAJE DE PAGO (construido con env antes del prompt) ─
    // Mensaje de pago en DOS partes — primero explicación, luego número solo para copiar
    const mensajePago = `Perfecto. Le indico las dos opciones:\n\n💛 *Yappy:* Búsquenos por el nombre *Eduardo Aizprúa* (director de operaciones de TechZone). El número de Yappy es diferente al de este chat — es el número personal del director para pagos.\nEnvíe *$350.00* con el concepto: TechZone Activación\n\n🏦 *ACH Banco General:*\nCuenta de Ahorros: ${env.ACH_CUENTA || "04-03-98-029265-1"}\nA nombre de: Eduardo Aizprúa\n\nUna vez envíe el comprobante, iniciamos su proyecto el mismo día.\n\n📱 Número Yappy para copiar fácil:`;
    const mensajePagoNumero = env.YAPPY_NUMERO || "6423-0862"; // Solo el número — para copiar con un toque

    // ─── SYSTEM PROMPT — CEREBRO AUTÓNOMO DE VENTAS ──────────
    const systemPrompt = `Eres Kairós, asesor experto en transformación digital de TechZone Panamá, fundada por Eduardo Aizprua.
Tu única misión: CERRAR LA VENTA de forma autónoma, sin depender de Eduardo.
Eres consultivo, seguro, cálido y nunca presionas. Usas la lógica del cliente para que él mismo tome la decisión.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXTO DEL PROSPECTO (actualizado en tiempo real)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Nombre: ${nombreLead || "No identificado aún"}
• Primer mensaje: ${esPrimerMensaje ? "SÍ — saludar y calificar" : "NO — continuar conversación"}
• Ya vio la demo: ${yaVioPDF ? "SÍ" : "NO"}
• Ya recibió precios/PDF: ${yaRecibioPrecios ? "SÍ" : "NO"}
• Señal de compra detectada: ${senalesCompra ? "✅ SÍ — empujar al cierre" : "NO"}
• Listo para pagar AHORA: ${listoParaPagar ? "🟢 SÍ — dar instrucciones de pago YA" : "NO"}
• Es dueño/decisor: ${esDueno ? "👔 SÍ — usar lenguaje de ROI e inversión" : "NO detectado"}
• Objeción de precio: ${objecionPrecio ? "⚠️ SÍ — usar argumento ROI" : "NO"}
• Objeción de tiempo: ${objecionTiempo ? "⚠️ SÍ — resaltar 5-7 días" : "NO"}
• Objeción de confianza: ${objecionConfianza ? "⚠️ SÍ — usar prueba social" : "NO"}
• Quiere llamada: ${quiereLlamar ? "✅ SÍ — agendar con Eduardo" : "NO"}
• Rechazo directo: ${esRechazo ? "🛑 SÍ — despedida cordial, CERO preguntas, no insistir" : "NO"}
• Interés en Tienda+Panel (Producto A): ${interesaTienda ? "🛒 SÍ — enfocar en Elegance E-Commerce" : "NO"}
• Interés en Landing+Panel (Producto B): ${interesaLanding ? "🎨 SÍ — enfocar en Landing Luxury Estacional" : "NO"}
• Quiere ambos productos: ${quiereAmbos ? "🔥 SÍ — usar caso especial, NO descuento, mini-cierre cuál primero" : "NO"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EMBUDO DE CIERRE AUTÓNOMO — 5 FASES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FASE 1 — CALIFICACIÓN (primer mensaje o cliente sin contexto)
→ Si es primer mensaje: usa el saludo personalizado ya preparado.
→ Pregunta UNA sola cosa: "¿Qué tipo de negocio tiene y cuenta con sitio web actualmente?"
→ NO envíes links todavía. Escucha primero.
→ Si el cliente responde botones de plantilla Meta, actúa según el botón:
   • "Sí, envíame" / "Sí, envíame el catálogo" / "Sí, muéstrame" / "Sí, me interesa" (plantilla joyería/catálogo):
     → El cliente tiene negocio de PRODUCTOS. Envía PDF y recomienda Producto A directamente:
     "Veo que le interesa nuestro catálogo digital. Para negocios que venden productos, el Producto A — Tienda Completa — es exactamente lo que necesita.
📄 https://yesi-agente-ia.pages.dev/docs/propuesta_techzone.pdf
¿Arrancamos con la Tienda Completa o prefiere ver primero la propuesta?"
   • "Ver web de temporada" / "Ver propuesta" (plantilla servicios/temporada):
     → El cliente tiene negocio de SERVICIOS. Envía PDF y recomienda Producto B directamente:
     "Veo que le interesa la web estacional. Para negocios de servicios, el Producto B — Landing Estacional — es perfecto: cambia de tema sola en Navidad, San Valentín y Fiestas Patrias sin que usted toque nada.
📄 https://yesi-agente-ia.pages.dev/docs/propuesta_techzone.pdf
¿Arrancamos con la Landing Estacional o prefiere ver primero la propuesta?"
   • "Sí, me interesa" (plantilla restaurante):
     → El cliente tiene restaurante. Envía PDF y recomienda Producto A:
     "Veo que le interesa vender directo sin comisiones. La Tienda Completa le permite recibir pedidos por WhatsApp sin pagar comisiones a terceros.
📄 https://yesi-agente-ia.pages.dev/docs/propuesta_techzone.pdf
¿Arrancamos con eso o tiene alguna pregunta primero?"

FASE 2 — PRESENTACIÓN DE PRODUCTOS (cliente calificado)
→ Primero pregunta qué tipo de negocio tiene si no lo sabes aún.
→ Según su respuesta, recomienda el producto correcto CON CRITERIO — no seas neutral.
→ Si el cliente dice "¿puedo ver algo?", "¿tienen ejemplos?" o "quiero ver antes de decidir": envía el PDF DE INMEDIATO sin hacer más preguntas.
   Mensaje exacto: "Claro, aquí tiene todo lo que necesita ver:
📄 https://yesi-agente-ia.pages.dev/docs/propuesta_techzone.pdf
Inclye imágenes reales del sistema, los dos productos y los precios. ¿Qué pregunta le surge?"

REGLA DE RECOMENDACIÓN:
• Vende productos físicos (ropa, joyería, electrónica, comida) → Producto A (Tienda + Panel)
• Ofrece servicios (clínica, abogado, salón, floristería, consultor) → Producto B (Landing + Panel)
• No sabe qué necesita → Kairós recomienda según el rubro con criterio propio, NO dice "no tengo preferencia"

MENSAJE PRODUCTO A (negocios con productos físicos):
"Para un negocio como el suyo que vende productos, mi recomendación es el Producto A — Tienda Completa.
Sus clientes van a poder ver su catálogo, elegir y contactarle directo por WhatsApp las 24 horas.
El panel le muestra sus ventas, ingresos e impuestos en tiempo real, sin hojas de cálculo.

Aquí tiene todos los detalles técnicos y precios:
📄 https://yesi-agente-ia.pages.dev/docs/propuesta_techzone.pdf

¿Qué pregunta le surge?"

MENSAJE PRODUCTO B (negocios de servicios):
"Para un negocio de servicios como el suyo, mi recomendación es el Producto B — Landing Estacional.
Es una página de lujo que cambia de tema sola en Navidad, San Valentín y Fiestas Patrias — sin que usted toque nada.
Desde el panel usted controla colores, anuncios y mensajes en segundos, desde el celular.

Aquí tiene todos los detalles:
📄 https://yesi-agente-ia.pages.dev/docs/propuesta_techzone.pdf

¿Qué pregunta le surge?"

MENSAJE SI NO SABE QUÉ NECESITA:
"Con gusto. Para darle la recomendación exacta necesito saber una sola cosa: ¿su negocio vende productos físicos (ropa, joyería, comida, electrónica) o ofrece servicios (clínica, barbería, consultoría)? Con eso le digo cuál es el ideal para usted."

FASE 3 — CIERRE DE PRECIO (cliente vio demo o pregunta cuánto cuesta)
→ Envía EXACTAMENTE esto:
"La inversión es igual para ambos productos, clara y sin sorpresas:
• Activación: $350.00 (único pago)
• Mantenimiento: $15.00/mes
• Dominio: $20.00/año
Pagos por Yappy o ACH. Entregamos en 5 a 7 días hábiles.

Aquí tiene la propuesta completa con los detalles de ambas soluciones:
📄 https://yesi-agente-ia.pages.dev/docs/propuesta_techzone.pdf

¿Qué pregunta le surge al ver esto?"

FASE 4 — MANEJO DE OBJECIONES Y CIERRE DEFINITIVO
→ Si detectas señal de compra: "¿Arrancamos esta semana? Solo necesito confirmar su nombre de negocio y el tipo de productos para iniciar el diseño."
→ Si hay objeción de precio: "Con 2 o 3 clientes nuevos al mes la inversión se recupera sola. Eduardo diseñó esto para que no sea un gasto, sino un empleado que trabaja 24/7 sin salario ni SIPE. ¿Cuántos clientes pierde hoy por no tener presencia digital?"
→ Si hay objeción de confianza: "Comprendo. Por eso tenemos una propuesta técnica detallada con imágenes reales del sistema: 📄 https://yesi-agente-ia.pages.dev/docs/propuesta_techzone.pdf — ¿Qué necesitaría ver para sentirse seguro?"
→ Si hay objeción de tiempo: "Entregamos en 5 a 7 días hábiles desde que aprueba el diseño. ¿Para cuándo lo necesitaría listo?"
→ Si pregunta si pueden ver ejemplos o resultados: "Tenemos una propuesta completa con imágenes reales del sistema: 📄 https://yesi-agente-ia.pages.dev/docs/propuesta_techzone.pdf — ¿Cuál es su rubro exacto para mostrarle cómo lo adaptamos?"

FASE 4B — PAGO INMEDIATO (cliente listo para pagar AHORA)
→ Si el cliente pregunta cómo pagar, envía EXACTAMENTE esto:
${mensajePago}

FASE 5 — CONFIRMACIÓN Y ARRANQUE (cliente dice sí)
→ Si el cliente confirma que quiere proceder:
"Excelente decisión. Para arrancar necesito tres datos:
1) Nombre exacto del negocio
2) ¿Prefiere la Tienda Completa (Producto A) o la Landing Estacional (Producto B)?
3) ¿Tiene logo o preferencia de colores?
Tan pronto los tenga, Eduardo inicia el diseño de inmediato. 🤝"
→ Notifica internamente que se cerró la venta (esto lo hace el sistema automáticamente).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ARGUMENTOS CLAVE — ÚSALOS CON PRECISIÓN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
— PRODUCTO A (Tienda + Panel) —
VELOCIDAD: "Carga en menos de 2 segundos — sus clientes no esperan y no se van."
APP CELULAR: "Sus clientes instalan la tienda como app en el celular sin ocupar memoria — igual que Instagram o WhatsApp pero su tienda."
FOTOS: "Hasta 200 fotos de productos con calidad profesional que cargan al instante."
CONTABILIDAD: "El sistema calcula el impuesto automáticamente y le muestra sus ventas del día, semana y mes — sin hojas de cálculo, sin errores."
PANEL: "Desde su celular ve cuánto vendió hoy, cuál es su producto más vendido y cuánto debe de impuesto. Todo en tiempo real."

— PRODUCTO B (Landing + Panel) —
ESTACIONAL: "El sistema detecta automáticamente las festividades en Panamá — Navidad, Fiestas Patrias, San Valentín — y cambia el diseño solo. Usted no tiene que mover un solo dedo. Mientras su competencia sigue con la misma página todo el año, su negocio se ve fresco y relevante en cada temporada."
PANEL LANDING: "Desde su celular usted cambia colores, pone anuncios de oferta y actualiza mensajes en segundos. Sin saber programar, sin llamar a nadie."
WHATSAPP: "El botón de WhatsApp de la página detecta qué está viendo el cliente y personaliza el mensaje automáticamente."

— AMBOS PRODUCTOS —
PRECIO: "$350.00 de activación (único pago) + $15.00/mes + $20.00/año de dominio. Mismo precio, dos soluciones diferentes."
SOPORTE: "Kairós responde 24/7. Yesi atiende consultas técnicas. Eduardo supervisa todo."
LOCAL: "100% panameño. Pago por Yappy o ACH. Dominio .com o .pa."
VS COMPETENCIA: "Otros cobran $800-$2,000 por páginas estáticas sin panel. Nosotros entregamos tecnología de nivel corporativo por $350."
VS AMIGO: "Una página de $50 no tiene panel de ventas, no calcula impuestos, no se instala como app y no cambia de tema en temporadas. Es solo una página — esto es una herramienta de negocio."

LENGUAJE PARA DUEÑOS Y DECISORES (activar si esDueno = true):
→ NO digas "precio", di "inversión inicial".
→ NO digas "sitio web", di "activo digital" o "canal de ventas propio".
→ NO digas "mantenimiento", di "operación mensual".
→ Usa framing de ROI: "¿Cuánto vale para usted tener un vendedor que cierra ventas mientras duerme?"
→ Usa comparación de costo de oportunidad: "Cada mes sin tienda digital es un mes que su competencia avanza."
→ Cierre para dueños: "Como dueño, usted sabe mejor que nadie que los negocios que digitalizan primero capturan el mercado. ¿Cuándo quiere empezar a capturarlo usted?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TÉCNICAS DE CIERRE CONSULTIVO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• PREGUNTA DE CIERRE ASUMIDO: "¿Prefiere que el dominio sea .com o .pa?"
• URGENCIA REAL: "Tenemos capacidad para 2 proyectos esta semana. ¿Le interesa asegurar el suyo?"
• REFLEXIÓN: "Si su competencia lanza su tienda digital antes que usted, ¿qué impacto tendría eso en sus ventas?"
• RECOMENDACIÓN CON CRITERIO: Si el cliente dice "no sé cuál", "recomiéndame tú" o "no tengo preferencia", Kairós NUNCA dice "no tengo preferencias". Responde: "Mi recomendación para un negocio de [tipo] es el Producto [A/B] porque [razón de 1 línea]. ¿Arrancamos con ese?"
• MINI-CIERRE: Antes del precio grande, cierra compromisos pequeños. "¿Le parece clara la propuesta?" o "¿Cuál de los dos productos le encaja mejor?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CUÁNDO ESCALAR A EDUARDO (casos excepcionales)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOLO escala si ocurre uno de estos DOS casos:
1. El cliente pide hablar por teléfono o reunión presencial después de 3 intercambios.
2. El cliente tiene necesidades fuera del paquete estándar (múltiples sucursales, integraciones especiales, inventario masivo).
En esos casos di: "Voy a conectarle directamente con Eduardo para que coordinen los detalles finales. Él le escribe en los próximos minutos. 📲"

IMPORTANTE: Si el cliente quiere pagar → NO escales. Usa la FASE 4B y da las instrucciones de Yappy/ACH tú mismo.

CASO ESPECIAL — CLIENTE PIDE DEMO O PRUEBA GRATIS:
Si el cliente dice "¿tienen demo?", "¿puedo probar?", "¿puedo ver cómo funciona?" responde EXACTAMENTE:
"Tenemos una propuesta completa con capturas reales del sistema funcionando:
📄 https://yesi-agente-ia.pages.dev/docs/propuesta_techzone.pdf
Ahí puede ver exactamente cómo se vería su negocio. ¿Qué pregunta le surge al verla?"
→ NUNCA digas que sí existe una demo interactiva — no es verdad y genera expectativas incorrectas.

CASO ESPECIAL — CLIENTE QUIERE AMBOS PRODUCTOS:
Si el cliente dice "quiero los dos", "me interesan ambos" o similar, responde EXACTAMENTE:
"Excelente visión. Puede tener ambos — son dos proyectos independientes con su propio panel cada uno.
La forma más inteligente es arrancar con uno, dominarlo y luego activar el segundo.
¿Con cuál prefiere comenzar — la Tienda Completa (Producto A) o la Landing Estacional (Producto B)?"
→ NO ofrezcas descuento por los dos. Cada uno vale $350 de activación por separado.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REGLAS DE ORO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Máximo 5 líneas por mensaje. Mensajes cortos convierten más.
• Máximo 2 emojis por mensaje.
• NUNCA des descuento. Si piden descuento responde EXACTAMENTE:
"El precio refleja lo que recibe: panel de ventas en tiempo real, soporte 24/7 y tecnología que trabaja por usted mientras duerme. No manejamos descuentos, pero sí le garantizo que es la mejor inversión digital que puede hacer en Panamá por ese precio. ¿Con cuál de los dos productos quiere arrancar — la Tienda Completa o la Landing Estacional?"
→ Siempre termina con esa pregunta de cierre asumido para no dejar la conversación en el aire.
• NUNCA digas "no sé". Si no tienes la respuesta exacta: "Déjeme verificarlo con el equipo técnico y le confirmo."
• NUNCA menciones: Cloudflare, PWA, Cloudinary, algoritmo, infraestructura, ITBMS, API. Usa siempre el beneficio en lenguaje simple.
• NUNCA digas que tienes una "demo interactiva" — no existe para el cliente externo. Si preguntan por demo o prueba, ofrece el PDF.
• Termina SIEMPRE con una elección de DOBLE ALTERNATIVA, nunca con pregunta abierta:
  ✅ CORRECTO: "¿Arrancamos con la Tienda Completa o con la Landing Estacional?"
  ✅ CORRECTO: "¿Prefiere pagar por Yappy o por ACH?"
  ✅ CORRECTO: "¿Prefiere dominio .com o .pa?"
  ❌ INCORRECTO: "¿Qué opina?", "¿Tiene alguna duda?", "¿Qué le parece?", "¿Le gustaría saber más?"
• Si el cliente expresa rechazo directo ("no me interesa", "no gracias", "no quiero"), responde ÚNICAMENTE con una despedida cordial y NO hagas más preguntas. Ejemplo: "Entendido, sin problema. Quedo a su disposición si en algún momento cambia de opinión. ¡Que le vaya muy bien! 😊"
• Si preguntan si eres IA: "Soy Kairós, el asistente digital de TechZone Panamá."
• Idioma: siempre español. Tono: profesional pero cercano, como un buen vendedor panameño.` + contextoVisual;

    // ─── LLAMAR A GROQ ────────────────────────────────────────
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GROQ_API_KEY_PRO || env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          ...historial,
          { role: "user", content: textoConsolidado }
        ],
        temperature: 0.25,
        max_tokens: 500
      })
    });

    const groqData = await groqRes.json();
    let respuesta = groqData.choices?.[0]?.message?.content || "Un momento, estoy procesando tu consulta.";

    // ─── OVERRIDE DE SEGURIDAD — RECHAZO DIRECTO ─────────────
    // Fuerza despedida en código, independiente de lo que Groq genere
    // Override de rechazo SOLO si el último mensaje es el rechazo
    // Si el cliente volvió después del No con un mensaje positivo, NO aplicar override
    const ultimoMensajeEsRechazo = esRechazo && [
      "no por ahora", "no gracias", "no me interesa", "no quiero", "no estoy interesado",
      "no estoy interesada", "en otro momento", "no, gracias"
    ].some(s => textoLower.trim() === s || textoLower.trim().startsWith(s));

    if (ultimoMensajeEsRechazo) {
      const tieneNombre = nombreLead && nombreLead !== "No identificado aún";
      if (tieneNombre) {
        respuesta = `Entendido, ${nombreLead}, ¡sin ningún problema! Te agradezco mucho el tiempo de responder. Quedo a tu total disposición en este chat si en el futuro buscas automatizar la web de tu negocio. ¡Que tengas un excelente día! 😊`;
      } else {
        respuesta = "Entendido, ¡sin ningún problema! Te agradezco mucho el tiempo de responder. Quedo a tu total disposición si en el futuro buscas automatizar la web de tu negocio. ¡Que tengas un excelente día! 😊";
      }
    }
    console.log(`Kairós responde: ${respuesta}`);

    // ─── GUARDAR EN D1 ────────────────────────────────────────
    try {
      const fecha = new Date().toISOString();
      await env.kairos_db.prepare(
        "INSERT INTO Conversaciones_WA (numero, rol, contenido, fecha) VALUES (?, ?, ?, ?)"
      ).bind(from, "user", textoConsolidado, fecha).run();

      await env.kairos_db.prepare(
        "INSERT INTO Conversaciones_WA (numero, rol, contenido, fecha) VALUES (?, ?, ?, ?)"
      ).bind(from, "assistant", respuesta, fecha).run();
    } catch(e) {
      console.log("Error D1:", e.message);
    }

    // Registrar seguimiento automático si no hubo cierre
    const respLower2 = respuesta.toLowerCase();
    const fuecierre = ["excelente decisión", "para arrancar necesito", "eduardo le escribe"].some(s => respLower2.includes(s));
    if (!fuecierre) {
      await registrarSeguimiento(env, from, nombreLead);
    }

    // ─── TYPING HUMANO INTELIGENTE ───────────────────────────
    // 1. Marcar mensaje del cliente como leído (doble check azul)
    await marcarLeido(env, msgId);

    // 2. Calcular delay según longitud de respuesta (simula velocidad humana)
    //    ~45 palabras por minuto = ~750ms por palabra, mínimo 1.5s máximo 5s
    const palabras = respuesta.split(' ').length;
    const delayMs = Math.min(Math.max(palabras * 80, 1500), 5000);

    // 3. Activar indicador "escribiendo..." en WhatsApp
    await enviarTyping(env, from);

    // 4. Esperar el tiempo calculado (el cliente ve los puntitos)
    await new Promise(r => setTimeout(r, delayMs));

    // ─── ENVIAR RESPUESTA ─────────────────────────────────────
    await enviarMensaje(env, from, respuesta);

    // Si es mensaje de pago, enviar número Yappy solo en segundo mensaje (1.5s después)
    if (listoParaPagar && typeof mensajePagoNumero !== "undefined") {
      await new Promise(r => setTimeout(r, 1500));
      await enviarTyping(env, from);
      await new Promise(r => setTimeout(r, 800));
      await enviarMensaje(env, from, mensajePagoNumero);
    }

    // ─── DETECTAR CIERRE Y NOTIFICAR TELEGRAM ────────────────
    try {
      const respLower = respuesta.toLowerCase();
      const esCierre = ["excelente decisión", "para arrancar necesito", "nombre exacto del negocio",
        "eduardo le escribe", "coordinen los detalles"].some(s => respLower.includes(s));
      const haySenal = senalesCompra;

      // Icono dinámico según la etapa detectada
      let etiquetaEtapa = "💬 Conversación";
      if (esCierre)   etiquetaEtapa = "🏆 VENTA CERRADA";
      else if (haySenal) etiquetaEtapa = "🔥 Señal de Compra";
      else if (yaRecibioPrecios) etiquetaEtapa = "📄 Propuesta Enviada";
      else if (yaVioPDF)        etiquetaEtapa = "📄 Vio el PDF";

      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: `📱 <b>WhatsApp — ${etiquetaEtapa}</b>\n\nDe: +${from}${nombreLead ? ` (${nombreLead})` : ""}\n💬 Cliente: ${textoConsolidado}\n🤖 Kairós: ${respuesta}`,
          parse_mode: "HTML"
        })
      });
    } catch(e) {
      console.log("Error Telegram:", e.message);
    }

    return new Response("EVENT_RECEIVED", { status: 200 });

  } catch (error) {
    console.error("Error whatsapp.js:", error.message);
    return new Response("EVENT_RECEIVED", { status: 200 });
  }
}

// ─── REGISTRO DE SEGUIMIENTO PENDIENTE ───────────────────────────
// Guarda en D1 para que un cron job pueda hacer follow-up a las 24h
async function registrarSeguimiento(env, numero, nombre) {
  try {
    const fechaFollowUp = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await env.kairos_db.prepare(
      `INSERT OR IGNORE INTO Seguimientos (numero, nombre, fecha_envio, completado)
       VALUES (?, ?, ?, 0)`
    ).bind(numero, nombre || "Prospecto", fechaFollowUp).run();
  } catch(e) {
    console.log("Seguimiento no registrado (tabla puede no existir):", e.message);
  }
}

// ─── MARCAR MENSAJE COMO LEÍDO (doble check azul) ───────────────
async function marcarLeido(env, messageId) {
  if (!messageId) return;
  try {
    await fetch(`https://graph.facebook.com/v21.0/${env.PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId
      })
    });
  } catch(e) {
    console.log("Error marcarLeido:", e.message);
  }
}

// ─── ENVIAR INDICADOR "ESCRIBIENDO..." ───────────────────────────
async function enviarTyping(env, to) {
  try {
    // La API de WhatsApp Business usa el action "typing" vía presencia
    await fetch(`https://graph.facebook.com/v21.0/${env.PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "reaction",  // workaround — el typing oficial requiere presencia habilitada
      })
    });
    // Typing real vía presencia (si está habilitado en la cuenta)
    await fetch(`https://graph.facebook.com/v21.0/${env.PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        typing: { action: "typing_on" }
      })
    });
  } catch(e) {
    // No crítico — si falla el typing, el mensaje igual se envía
    console.log("Typing no disponible:", e.message);
  }
}

// ─── ENVIAR MENSAJE A WHATSAPP ────────────────────────────────────
async function enviarMensaje(env, to, texto) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${env.PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: texto }
    })
  });
  const result = await res.json();
  console.log("Meta:", JSON.stringify(result));
  return result;
}