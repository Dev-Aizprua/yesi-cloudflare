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

    // ─── SOLO TEXTO POR AHORA ─────────────────────────────────
    if (tipo !== "text") {
      await enviarMensaje(env, from, "Recibí tu mensaje. Por ahora solo proceso texto — pronto podré escuchar audios también.");
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    const textoRecibido = message.text.body;
    console.log(`Mensaje de ${from}: ${textoRecibido}`);

    // ─── CARGAR HISTORIAL DE D1 ───────────────────────────────
    let historial = [];
    try {
      const result = await env.kairos_db.prepare(
        "SELECT rol, contenido FROM Conversaciones_WA WHERE numero = ? ORDER BY id DESC LIMIT 10"
      ).bind(from).all();
      historial = (result.results || []).reverse().map(r => ({
        role: r.rol,
        content: r.contenido
      }));
    } catch(e) {
      console.log("Sin historial:", e.message);
    }

    // ─── SYSTEM PROMPT DE VENTAS ──────────────────────────────
    const systemPrompt = `Eres Kairós, agente de ventas de TechZone Panamá. Respondes por WhatsApp Business.

MISIÓN: Convertir prospectos en clientes de tiendas web y presencia digital.

METODOLOGÍA DE VENTAS:
- Si muestra INTERÉS ("sí", "dale", "cuéntame", "¿cuánto?", "¿de qué trata?"):
  → Envía link de demo según rubro: restaurantes/retail → https://techzone-pro.com | joyería → https://elegancejewelry-pa.com
  → Ofrece llamada de 15 minutos
- Si tiene DUDAS de precio o seguridad:
  → ROI: "Los negocios recuperan la inversión en 30-60 días con solo 2-3 ventas extra al mes"
  → Seguridad: "Incluye SSL y carga en menos de 1 segundo gracias a Cloudflare"
  → "Funciona perfecto desde el celular, donde está el 90% de sus clientes"
- Si RECHAZA ("no gracias", "no me interesa", "NO"):
  → Retirada elegante: agradece y quédate disponible, no insistas

REGLAS:
- Máximo 3-4 líneas por mensaje
- Tono cercano y profesional
- Si preguntan si eres IA: "Soy un asistente digital de TechZone Panamá"
- Máximo 1-2 emojis por mensaje
- Siempre en español`;

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
          { role: "user", content: textoRecibido }
        ],
        temperature: 0.3,
        max_tokens: 300
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
      ).bind(from, "user", textoRecibido, fecha).run();

      await env.kairos_db.prepare(
        "INSERT INTO Conversaciones_WA (numero, rol, contenido, fecha) VALUES (?, ?, ?, ?)"
      ).bind(from, "assistant", respuesta, fecha).run();
    } catch(e) {
      console.log("Error D1:", e.message);
    }

    // ─── SIMULAR ESCRIBIENDO (3 segundos) ────────────────────
    await new Promise(r => setTimeout(r, 3000));

    // ─── ENVIAR RESPUESTA ─────────────────────────────────────
    await enviarMensaje(env, from, respuesta);

    // ─── NOTIFICAR TELEGRAM ───────────────────────────────────
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: `📱 <b>WhatsApp — Conversación</b>\n\nDe: +${from}\n💬 ${textoRecibido}\n🤖 Kairós: ${respuesta}`,
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