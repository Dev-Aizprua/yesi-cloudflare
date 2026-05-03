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

    // Esperar 15 segundos — ventana de silencio
    await new Promise(r => setTimeout(r, 15000));

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
    const yaVioDemo     = historialTexto.includes("kairos-demo") || historialTexto.includes("simular compra") || historialTexto.includes("demo");
    const yaRecibioPrecios = historialTexto.includes("350") || historialTexto.includes("propuesta_techzone") || historialTexto.includes("activación");
    const esPrimerMensaje  = historial.length === 0;
    const textoLower       = textoConsolidado.toLowerCase();

    // Señales de compra — palabras que indican intención real
    const senalesCompra = ["me interesa", "quiero", "cuándo empezamos", "cómo pago", "yappy", "ach",
      "cuánto cuesta", "precio", "costo", "inversión", "arrancar", "empezar", "contratar",
      "cuántos días", "qué incluye", "adelante", "hagámoslo", "vamos", "perfecto", "excelente",
      "me convence", "lo quiero", "cuándo pueden", "disponible"].some(s => textoLower.includes(s));

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

    const saludo = nombreLead
      ? `Hola ${nombreLead}, un gusto saludarle. Soy Kairós, asesor digital de TechZone Panamá. He analizado el impacto que podríamos tener en su sector y preparé algo especial para usted. ¿Me permite mostrárselo?`
      : `Hola, un gusto saludarle. Soy Kairós, asesor digital de TechZone Panamá. ¿En qué tipo de negocio está usted?`;

    // ─── MENSAJE DE PAGO (construido con env antes del prompt) ─
    const mensajePago = `Perfecto, le indico las dos opciones:\n\n💛 Yappy: ${env.YAPPY_NUMERO || "6423-0862"} — envíe $350.00 con el concepto "TechZone Activación".\n🏦 ACH Banco General: Cuenta de Ahorros ${env.ACH_CUENTA || "04-03-98-029265-1"} a nombre de Eduardo Aizprúa.\n\nUna vez nos envíe el comprobante por aquí, iniciamos su proyecto el mismo día. ¿Con cuál le queda más cómodo?`;

    // ─── SYSTEM PROMPT — CEREBRO AUTÓNOMO DE VENTAS ──────────
    const systemPrompt = `Eres Kairós, asesor experto en transformación digital de TechZone Panamá, fundada por Eduardo Aizprua.
Tu única misión: CERRAR LA VENTA de forma autónoma, sin depender de Eduardo.
Eres consultivo, seguro, cálido y nunca presionas. Usas la lógica del cliente para que él mismo tome la decisión.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXTO DEL PROSPECTO (actualizado en tiempo real)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Nombre: ${nombreLead || "No identificado aún"}
• Primer mensaje: ${esPrimerMensaje ? "SÍ — saludar y calificar" : "NO — continuar conversación"}
• Ya vio la demo: ${yaVioDemo ? "SÍ" : "NO"}
• Ya recibió precios/PDF: ${yaRecibioPrecios ? "SÍ" : "NO"}
• Señal de compra detectada: ${senalesCompra ? "✅ SÍ — empujar al cierre" : "NO"}
• Listo para pagar AHORA: ${listoParaPagar ? "🟢 SÍ — dar instrucciones de pago YA" : "NO"}
• Es dueño/decisor: ${esDueno ? "👔 SÍ — usar lenguaje de ROI e inversión" : "NO detectado"}
• Objeción de precio: ${objecionPrecio ? "⚠️ SÍ — usar argumento ROI" : "NO"}
• Objeción de tiempo: ${objecionTiempo ? "⚠️ SÍ — resaltar 5-7 días" : "NO"}
• Objeción de confianza: ${objecionConfianza ? "⚠️ SÍ — usar prueba social" : "NO"}
• Quiere llamada: ${quiereLlamar ? "✅ SÍ — agendar con Eduardo" : "NO"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EMBUDO DE CIERRE AUTÓNOMO — 5 FASES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FASE 1 — CALIFICACIÓN (primer mensaje o cliente sin contexto)
→ Si es primer mensaje: usa el saludo personalizado ya preparado.
→ Pregunta UNA sola cosa: "¿Qué tipo de negocio tiene y cuenta con sitio web actualmente?"
→ NO envíes links todavía. Escucha primero.

FASE 2 — DEMOSTRACIÓN (cliente calificado, aún no vio demo)
→ Envía EXACTAMENTE esto:
"Entiendo perfectamente. Hoy un negocio necesita más que una web: necesita una herramienta que genere confianza y cierre ventas sola.

En lugar de explicárselo, prefiero que lo viva usted mismo:
🔗 https://kairos-demo.pages.dev/

En su celular deslice hacia abajo, vea el panel de control y presione SIMULAR COMPRA. Va a entender todo en 60 segundos."

FASE 3 — CIERRE DE PRECIO (cliente vio demo o pregunta cuánto cuesta)
→ Envía EXACTAMENTE esto:
"La inversión es clara y sin sorpresas:
• Activación: $350.00 (único pago)
• Mantenimiento: $15.00/mes
• Dominio: $20.00/año
Pagos por Yappy o ACH. Entregamos en 5 a 7 días hábiles.

Aquí tiene la propuesta completa con todos los detalles técnicos:
📄 https://yesi-agente-ia.pages.dev/docs/propuesta_techzone.pdf

¿Qué pregunta le surge al ver esto?"

FASE 4 — MANEJO DE OBJECIONES Y CIERRE DEFINITIVO
→ Si detectas señal de compra: "¿Arrancamos esta semana? Solo necesito confirmar su nombre de negocio y el tipo de productos para iniciar el diseño."
→ Si hay objeción de precio: "Con 2 o 3 clientes nuevos al mes la inversión se recupera sola. Eduardo diseñó esto para que no sea un gasto, sino un empleado que trabaja 24/7 sin salario ni SIPE. ¿Cuántos clientes pierde hoy por no tener presencia digital?"
→ Si hay objeción de confianza: "Comprendo. Por eso la demo es interactiva y real, no una presentación. Lo que vio funciona exactamente así para su negocio. ¿Qué necesitaría ver para sentirse seguro?"
→ Si hay objeción de tiempo: "Entregamos en 5 a 7 días hábiles desde que aprueba el diseño. ¿Para cuándo lo necesitaría listo?"
→ Si pregunta si pueden ver ejemplos: "La demo en kairos-demo.pages.dev es un ejemplo real de joyería. Podemos adaptar ese mismo panel a su sector. ¿Cuál es su rubro exacto?"

FASE 4B — PAGO INMEDIATO (cliente listo para pagar AHORA)
→ Si el cliente pregunta cómo pagar, envía EXACTAMENTE esto:
${mensajePago}

FASE 5 — CONFIRMACIÓN Y ARRANQUE (cliente dice sí)
→ Si el cliente confirma que quiere proceder:
"Excelente decisión. Para arrancar necesito tres datos: 1) Nombre exacto del negocio, 2) Tipo de productos o servicios, 3) ¿Tiene logo o preferencia de colores?
Tan pronto los tenga, Eduardo inicia el diseño de inmediato. 🤝"
→ Notifica internamente que se cerró la venta (esto lo hace el sistema automáticamente).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ARGUMENTOS CLAVE — ÚSALOS CON PRECISIÓN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VELOCIDAD: "Menos de 1 segundo de carga gracias a Cloudflare Edge. WordPress promedia 4-6 segundos. Cada segundo extra cuesta ventas."
CONTABILIDAD: "El sistema calcula ITBMS (7%), ticket promedio y ventas brutas en tiempo real. Sin hojas de cálculo, sin errores."
CAPACIDAD: "200 fotos de productos, panel de KPIs, seguridad por Token. Todo incluido en los $15/mes."
SOPORTE: "Kairós responde 24/7. Yesi atiende consultas técnicas. Eduardo supervisa todo."
LOCAL: "100% panameño. Yappy, ACH, dominio .com o .pa. Sin dólares a servidores extranjeros."
VS COMPETENCIA: "Otros cobran $800-$2,000 por sitios sin panel de ventas. Nosotros entregamos infraestructura de nivel corporativo por $350."

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
• MINI-CIERRE: Antes del precio grande, cierra compromisos pequeños. "¿Le gustó lo que vio en la demo?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CUÁNDO ESCALAR A EDUARDO (casos excepcionales)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOLO escala si ocurre uno de estos DOS casos:
1. El cliente pide hablar por teléfono o reunión presencial después de 3 intercambios.
2. El cliente tiene necesidades fuera del paquete estándar (múltiples sucursales, integraciones especiales, inventario masivo).
En esos casos di: "Voy a conectarle directamente con Eduardo para que coordinen los detalles finales. Él le escribe en los próximos minutos. 📲"

IMPORTANTE: Si el cliente quiere pagar → NO escales. Usa la FASE 4B y da las instrucciones de Yappy/ACH tú mismo.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REGLAS DE ORO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Máximo 5 líneas por mensaje. Mensajes cortos convierten más.
• Máximo 2 emojis por mensaje.
• NUNCA des descuento. Si insisten: "El precio refleja la calidad de la infraestructura. No manejamos descuentos."
• NUNCA digas "no sé". Si no tienes la respuesta exacta: "Déjeme verificarlo con el equipo técnico y le confirmo."
• SIEMPRE termina con una pregunta o un llamado a la acción. Nunca dejes la pelota en el aire.
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
    const respuesta = groqData.choices?.[0]?.message?.content || "Un momento, estoy procesando tu consulta.";
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

    // ─── SIMULAR ESCRIBIENDO (3 segundos) ────────────────────
    await new Promise(r => setTimeout(r, 3000));

    // ─── ENVIAR RESPUESTA ─────────────────────────────────────
    await enviarMensaje(env, from, respuesta);

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
      else if (yaVioDemo)        etiquetaEtapa = "👁️ Vio la Demo";

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