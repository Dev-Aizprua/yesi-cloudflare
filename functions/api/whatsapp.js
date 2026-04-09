// CONFIGURACIÓN DE KAIRÓS PARA WHATSAPP
const VERIFY_TOKEN = "KAIROS_WA_2026"; // Esta es la palabra clave para Meta

export async function onRequestGet(context) {
  // 1. OBTENER LOS PARÁMETROS QUE ENVÍA META
  const { searchParams } = new URL(context.request.url);
  
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  // 2. VALIDACIÓN DEL WEBHOOK
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("WEBHOOK_VERIFIED");
    // Meta espera recibir el 'challenge' de vuelta para confirmar que el servidor es tuyo
    return new Response(challenge, { status: 200 });
  }

  // Si el token no coincide
  return new Response("Error de verificación: Token incorrecto", { status: 403 });
}

export async function onRequestPost(context) {
  try {
    // 3. RECIBIR LOS MENSAJES DE WHATSAPP
    const body = await context.request.json();

    // Verificamos que sea un mensaje de WhatsApp válido
    if (body.object === "whatsapp_business_account") {
      if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
        
        // Aquí es donde Kairós procesará el mensaje en el futuro
        console.log("Nuevo mensaje recibido de WhatsApp");
        
        // Respondemos 200 OK a Meta para confirmar que recibimos el mensaje
        return new Response("EVENT_RECEIVED", { status: 200 });
      }
    }

    return new Response("Objeto no reconocido", { status: 404 });
    
  } catch (error) {
    console.error("Error procesando mensaje:", error);
    return new Response("Error interno", { status: 500 });
  }
}