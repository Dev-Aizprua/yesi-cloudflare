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

      // Duración desde múltiples fuentes — WhatsApp no es consistente
      const fileSize = message.audio?.file_size || message.voice?.file_size || 0;
      const duracionVoice = message.voice?.duration || 0;
      const duracionReal = Math.max(duracion, duracionVoice);

      // Log para calibrar el límite de tamaño
      console.log(`Audio recibido — duration: ${duracion}s, voice_duration: ${duracionVoice}s, file_size: ${fileSize} bytes, type: ${message.type}`);
      console.log(`Objeto audio completo: ${JSON.stringify(message.audio || message.voice)}`);

      // Notificar a Telegram con datos del audio para calibración
      try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: `🎙️ <b>Audio recibido</b>\n\nDe: +${from}\nDuración campo: ${duracion}s\nDuración voice: ${duracionVoice}s\nTamaño: ${fileSize} bytes\nTipo: ${message.type}\nObjeto: ${JSON.stringify(message.audio || message.voice).substring(0,200)}`,
            parse_mode: "HTML"
          })
        });
      } catch(e) {}

      // Considerar largo si: duración > 20s O archivo > 120KB
      const esLargo = duracionReal > 20 || fileSize > 120000;

      // Audio largo — redirigir amigablemente sin transcribir
      if (esLargo) {
        await enviarMensaje(env, from, "¡Uy! Disculpa, mi sistema solo logra procesar audios cortitos de hasta 20 segundos para poder mantener la velocidad de la cotización. ⚡\n\n¿Podrías resumirme tu idea en un audio más corto o escribírmela por aquí de forma rápida?");
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
      "cuándo pago", "acepta yappy", "mandarle el pago",
      "por yappy", "con yappy", "por ach", "por transferencia",
      "yappy", "transferencia ach"].some(s => textoLower.includes(s));

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
    // Mensajes de pago SEPARADOS según lo que el cliente eligió (Yappy o ACH)
    const textoLowerPago = textoLower;
    const eligioYappy = ["yappy", "por yappy", "con yappy"].some(s => textoLowerPago.includes(s));
    const eligioAch   = ["ach", "transferencia", "banco", "cuenta"].some(s => textoLowerPago.includes(s));

    // Mensaje Yappy — solo datos de Yappy, sin cuenta bancaria
    const mensajePagoYappy = `Perfecto. Realiza el pago de $175.00 (anticipo 50%) por Yappy buscando el nombre *Eduardo Aizprúa* — nuestro director de operaciones.\n\nConcepto: TechZone Activación\n\nEl número de Yappy es diferente a este chat — es el número personal del director para pagos.\n\n¿Me avisas apenas lo envíes para que nuestro equipo inicie de inmediato?`;
    const mensajePagoNumero = env.YAPPY_NUMERO || "6423-0862";

    // Mensaje ACH — solo datos bancarios, sin Yappy
    const mensajePagoAch = `Perfecto. Realiza la transferencia del anticipo de $175.00 a:\n\n🏦 Banco General — Cuenta de Ahorros\nNúmero: ${env.ACH_CUENTA || "04-03-98-029265-1"}\nA nombre de: Eduardo Aizprúa\n\nUna vez nos envíes el comprobante por aquí, nuestro equipo inicia el diseño de inmediato. ¿Me avisas cuando lo envíes?`;

    // Mensaje genérico si no especificó método aún
    const mensajePago = `Perfecto. Para iniciar hoy mismo, ¿te queda más cómodo el anticipo de $175.00 por Yappy o por transferencia ACH de Banco General?`;
    const mensajePagoNumero2 = mensajePagoNumero; // alias para compatibilidad

    // ─── SYSTEM PROMPT — CEREBRO AUTÓNOMO DE VENTAS ──────────
    const systemPrompt = `Eres Kairós, asesor de ventas de TechZone Panamá (Eduardo Aizprúa). Misión: CERRAR LA VENTA de forma autónoma.

CONTEXTO DEL PROSPECTO:
• Nombre: ${nombreLead || "No identificado"}
• Primer mensaje: ${esPrimerMensaje ? "SÍ — saludar" : "NO"}
• Ya vio PDF: ${yaVioPDF ? "SÍ" : "NO"}
• Señal de compra: ${senalesCompra ? "✅ SÍ — empujar cierre" : "NO"}
• Listo para pagar: ${listoParaPagar ? "🟢 SÍ — dar instrucciones pago" : "NO"}
• Pago Yappy: ${eligioYappy ? "✅" : "NO"} | ACH: ${eligioAch ? "✅" : "NO"}
• Objeción precio: ${objecionPrecio ? "⚠️ SÍ" : "NO"}
• Quiere ambos: ${quiereAmbos ? "🔥 SÍ" : "NO"}
• Rechazo: ${esRechazo ? "🛑 SÍ" : "NO"}
• Interés Tienda: ${interesaTienda ? "🛒 SÍ" : "NO"} | Landing: ${interesaLanding ? "🎨 SÍ" : "NO"}
• Es dueño: ${esDueno ? "👔 SÍ" : "NO"}

EMBUDO — 5 FASES:

FASE 1 — CALIFICACIÓN:
• Primer mensaje: saludar y preguntar tipo de negocio.
• Botones Meta → producto directo SIN preguntar rubro:
  - "Sí, envíame" / "Sí, envíame el catálogo" / "Sí, me interesa" → Producto A: "Para negocios de productos, el Producto A — Tienda Completa — es perfecto.
📄 https://yesi-agente-ia.pages.dev/docs/propuesta_techzone.pdf
¿Arrancamos con la Tienda Completa o prefiere ver la propuesta?"
  - "Sí, muéstrame" / "Ver web de temporada" → Producto B: "Para negocios de servicios, el Producto B — Landing Estacional — es perfecto: cambia sola en Navidad, San Valentín y Fiestas Patrias.
📄 https://yesi-agente-ia.pages.dev/docs/propuesta_techzone.pdf
¿Arrancamos con la Landing Estacional o prefiere ver la propuesta?"
  - "No, gracias" / "No por ahora" / "En otro momento" → despedida cordial, NO preguntes nada más.

FASE 2 — PRESENTACIÓN:
• Productos físicos → Producto A. Servicios → Producto B.
• Si no sabe → recomienda Landing Estacional: "Para cualquier negocio, mi recomendación es la Landing Estacional — versátil, cambia sola por temporada y panel intuitivo desde el celular. ¿Arrancamos o prefiere la Tienda Completa si vende productos?"
• PDF SIEMPRE: 📄 https://yesi-agente-ia.pages.dev/docs/propuesta_techzone.pdf

FASE 3 — PRECIO (SOLO después de elegir producto):
• Si preguntan precio directamente: "La inversión total es $350. Para iniciar, solo el anticipo de $175 (50%). El saldo lo pagas cuando verificas que tu página quedó lista. ¿Arrancamos con la Tienda Completa o la Landing Estacional?"
• Después de elegir: "¡Gran decisión! La inversión: Anticipo $175 (50%) + Saldo $175 al aprobar + $15/mes + $20/año dominio. 5-7 días hábiles. ¿Yappy o ACH?"

FASE 4 — PAGO (NO dar ambos métodos juntos):
• Si Yappy: "Realiza el pago de $175 por Yappy buscando Eduardo Aizprúa — director de TechZone. Concepto: TechZone Activación. El número Yappy es diferente a este chat. ¿Me avisas cuando lo envíes?"
  Luego enviar: ${env.YAPPY_NUMERO || "6423-0862"}
• Si ACH: "Realiza la transferencia de $175 a:
🏦 Banco General — Cuenta de Ahorros
Número: ${env.ACH_CUENTA || "04-03-98-029265-1"}
A nombre de: Eduardo Aizprúa
¿Me avisas cuando lo envíes?"

FASE 5 — CIERRE:
"Excelente decisión. Para arrancar: 1) Nombre exacto del negocio 2) ¿Tienda Completa o Landing Estacional? 3) ¿Tiene logo o colores? Tan pronto los tenga iniciamos. ¿Prefiere dominio .com o .pa?"

OBJECIONES:
• Precio/caro: "Con 2-3 clientes nuevos al mes se recupera. Eduardo diseñó esto como un empleado que trabaja 24/7 sin salario ni SIPE. ¿Arrancamos con Tienda o Landing?"
• Amigo por $50: "Una página de $50 no tiene panel de ventas, no calcula impuestos, no se instala como app y no cambia en temporadas. ¿Cuál prefiere — Tienda o Landing?"
• Wix: "¿Su Wix tiene panel de ventas en tiempo real, cambia de tema en temporadas y se instala como app? Nosotros sí. ¿Arrancamos?"
• Descuento: "No manejamos descuentos. La inversión refleja panel en tiempo real y soporte 24/7. Para tu tranquilidad iniciamos con solo $175. ¿Tienda o Landing?"
• Quiere los dos: "Puede tener ambos — proyectos independientes. Lo inteligente es arrancar con uno. ¿Cuál primero — Tienda o Landing?"

ARGUMENTOS (sin tecnicismos):
• App celular: "Sus clientes instalan la tienda como app sin ocupar memoria — igual que Instagram pero su tienda."
• Fotos: "Hasta 200 fotos con calidad profesional que cargan al instante."
• Impuestos: "Calcula el impuesto automáticamente — sin hojas de cálculo."
• Panel: "Desde su celular ve ventas del día, producto más vendido e impuesto en tiempo real."
• Estacional: "El sistema detecta festividades en Panamá y cambia el diseño solo — Navidad, Fiestas Patrias, San Valentín. Usted no mueve un dedo."

ESCALAR A EDUARDO SOLO si: llamada telefónica solicitada tras 3 intercambios, o proyecto fuera del estándar.

REGLAS DE ORO:
• SIEMPRE terminar con doble alternativa: "¿Tienda Completa o Landing Estacional?" — NUNCA con "¿Qué opina?" o "¿Le gustaría saber más?"
• NUNCA mencionar: Cloudflare, PWA, Cloudinary, ITBMS, algoritmo, API.
• NUNCA decir "no sé" — si no sabes: "Déjeme verificarlo con el equipo técnico."
• NUNCA dar descuento.
• Máximo 5 líneas por mensaje. Máximo 2 emojis.
• Idioma: español. Tono: profesional y cercano.
• Si preguntan si eres IA: "Soy Kairós, el asistente digital de TechZone Panamá."` + contextoVisual;

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

    // ─── LOG DE ERROR GROQ ────────────────────────────────────
    if (!groqData.choices?.[0]?.message?.content) {
      console.error("Groq error response:", JSON.stringify(groqData));
      // Notificar a Telegram con el error real
      try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: `⚠️ <b>Error Groq</b>\n\nDe: +${from}\nError: ${JSON.stringify(groqData).substring(0, 300)}`,
            parse_mode: "HTML"
          })
        });
      } catch(e) {}
    }

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
    // ─── OVERRIDE DE PAGO — método específico según lo que eligió ──
    if (listoParaPagar) {
      if (eligioYappy) {
        respuesta = mensajePagoYappy;
      } else if (eligioAch) {
        respuesta = mensajePagoAch;
      } else {
        respuesta = mensajePago;
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

    // Segundo mensaje: número solo para copiar — SOLO si eligió Yappy
    if (listoParaPagar && eligioYappy) {
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