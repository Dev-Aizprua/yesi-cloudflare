// CONFIGURACIÓN DE KAIRÓS PARA WHATSAPP
const VERIFY_TOKEN = "KAIROS_WA_2026"; 

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

export async function onRequestPost(context) {
  const { env } = context; // Aquí es donde viven tus secretos
  
  try {
    const body = await context.request.json();

    if (body.object === "whatsapp_business_account") {
      const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      
      if (message) {
        console.log("Nuevo mensaje recibido de WhatsApp");
        const from = message.from; // El número de quien te escribe (tu celular)

        // --- LÓGICA DE RESPUESTA DE KAIRÓS ---
        const url = `https://graph.facebook.com/v21.0/${env.PHONE_NUMBER_ID}/messages`;
        
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: from,
            type: "text",
            text: { body: "¡Hola! Soy Kairós. Recibí tu mensaje: " + message.text.body }
          }),
        });

        const result = await response.json();
        console.log("Respuesta de Meta:", JSON.stringify(result));
        
        return new Response("EVENT_RECEIVED", { status: 200 });
      }
    }
    return new Response("No es un mensaje", { status: 200 });
    
  } catch (error) {
    console.error("Error en Kairós:", error);
    return new Response("Error", { status: 500 });
  }
}