 
// ─── /api/enviar-plantilla ────────────────────────────────────────
// Dispara una plantilla aprobada por Meta a un número de WhatsApp
// usando la API oficial de Cloud API de Meta.
//
// POST body: { numero, nombre_meta, variables: ["val1", "val2"] }
// Respuesta: { success, message_id } o { success: false, error }

// ── Mapa de plantillas Meta aprobadas ────────────────────────────
// nombre_meta → { variables que usa, producto que recomienda }
const PLANTILLAS_META = {
  prospeccion_temporada_panama: {
    label: "Temporada — Web Estacional",
    icono: "🎄",
    producto: "B",
    vars: 2, // {{1}} = nombre negocio, {{2}} = rubro
    botones: ["Ver web de temporada", "No, gracias"]
  },
  prospeccion_catalogo_panama: {
    label: "Catálogo Joyería",
    icono: "📦",
    producto: "A",
    vars: 1, // {{1}} = nombre negocio
    botones: ["Sí, envíame el catálogo", "En otro momento"]
  },
  prospeccion_servicios_v1: {
    label: "Servicios — Landing Estacional",
    icono: "🎨",
    producto: "B",
    vars: 2, // {{1}} = nombre negocio, {{2}} = ubicación/zona
    botones: ["Sí, muéstrame", "No por ahora"]
  },
  prospeccion_restaurantes_v1: {
    label: "Restaurante — Sin Comisiones",
    icono: "🍕",
    producto: "A",
    vars: 1, // {{1}} = nombre restaurante
    botones: ["Sí, me interesa", "No, gracias"]
  },
  prospeccion_joyeria_v1: {
    label: "Joyería — Propuesta Digital",
    icono: "💎",
    producto: "A",
    vars: 1, // {{1}} = nombre joyería
    botones: ["Sí, envíame", "No, gracias"]
  }
};

export async function onRequestPost(context) {
  const { request, env } = context;

  // ── Validar variables de entorno requeridas ──────────────────
  if (!env.WHATSAPP_TOKEN || !env.PHONE_NUMBER_ID) {
    return Response.json({
      success: false,
      error: "Variables de entorno WHATSAPP_TOKEN o PHONE_NUMBER_ID no configuradas"
    }, { status: 500 });
  }

  try {
    const body = await request.json();
    const { numero, nombre_meta, variables = [], prospecto_id, prospecto_nombre } = body;

    // ── Validaciones básicas ──────────────────────────────────
    if (!numero) {
      return Response.json({ success: false, error: "Falta el número de destino" }, { status: 400 });
    }
    if (!nombre_meta) {
      return Response.json({ success: false, error: "Falta el nombre_meta de la plantilla" }, { status: 400 });
    }
    if (!PLANTILLAS_META[nombre_meta]) {
      return Response.json({
        success: false,
        error: `Plantilla "${nombre_meta}" no reconocida. Disponibles: ${Object.keys(PLANTILLAS_META).join(", ")}`
      }, { status: 400 });
    }

    // ── Limpiar número — solo dígitos, con código de país ────
    const numeroParsed = numero.replace(/\D/g, "");
    if (numeroParsed.length < 10) {
      return Response.json({ success: false, error: "Número inválido: " + numero }, { status: 400 });
    }

    const plantillaInfo = PLANTILLAS_META[nombre_meta];

    // ── Construir componentes de la plantilla ─────────────────
    // Las plantillas de Meta usan {{1}}, {{2}}, etc. como variables
    const components = [];

    if (variables.length > 0) {
      const parametros = variables.map(v => ({
        type: "text",
        text: v || "su negocio"
      }));
      components.push({
        type: "body",
        parameters: parametros
      });
    }

    // ── Payload para la API de Meta ───────────────────────────
    const payload = {
      messaging_product: "whatsapp",
      to: numeroParsed,
      type: "template",
      template: {
        name: nombre_meta,
        language: { code: "es_PA" },
        components: components.length > 0 ? components : undefined
      }
    };

    // ── Llamar a la API de Meta ───────────────────────────────
    const metaRes = await fetch(
      `https://graph.facebook.com/v21.0/${env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }
    );

    const metaData = await metaRes.json();

    // ── Error de Meta ─────────────────────────────────────────
    if (metaData.error) {
      console.error("Error Meta API:", JSON.stringify(metaData.error));

      // Notificar a Telegram del error
      try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: `❌ <b>Error al enviar plantilla Meta</b>\n\nPlantilla: ${nombre_meta}\nNúmero: +${numeroParsed}\nError: ${metaData.error.message}`,
            parse_mode: "HTML"
          })
        });
      } catch(e) {}

      return Response.json({
        success: false,
        error: metaData.error.message,
        code: metaData.error.code
      }, { status: 400 });
    }

    const messageId = metaData.messages?.[0]?.id;

    // ── Registrar en D1 que se envió la plantilla ─────────────
    try {
      const fechaEnvio = new Date().toISOString();
      if (prospecto_id) {
        await env.kairos_db.prepare(
          `UPDATE Prospectos_WA SET estado = 'contactado', fecha_primer_envio = ?
           WHERE id = ? AND (fecha_primer_envio IS NULL OR fecha_primer_envio = '')`
        ).bind(fechaEnvio, prospecto_id).run();
      }

      // Guardar en conversaciones que se inició con esta plantilla
      if (numeroParsed) {
        await env.kairos_db.prepare(
          `INSERT INTO Conversaciones_WA (numero, rol, contenido) VALUES (?, ?, ?)`
        ).bind(
          numeroParsed,
          "assistant",
          `[Plantilla Meta enviada: ${nombre_meta}] ${plantillaInfo.label}`
        ).run();
      }
    } catch(e) {
      console.log("Error D1 registro plantilla:", e.message);
    }

    // ── Notificar a Telegram del envío exitoso ────────────────
    try {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: `📤 <b>Plantilla Meta enviada</b>\n\n${plantillaInfo.icono} ${plantillaInfo.label}\nPara: +${numeroParsed}${prospecto_nombre ? ` (${prospecto_nombre})` : ""}\nProducto: ${plantillaInfo.producto === "A" ? "Tienda Completa" : "Landing Estacional"}\nID: ${messageId}`,
          parse_mode: "HTML"
        })
      });
    } catch(e) {}

    return Response.json({
      success: true,
      message_id: messageId,
      plantilla: nombre_meta,
      label: plantillaInfo.label,
      producto: plantillaInfo.producto,
      numero: numeroParsed
    });

  } catch(e) {
    console.error("Error enviar-plantilla:", e.message);
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}

// GET — listar plantillas disponibles con su info
export async function onRequestGet(context) {
  const lista = Object.entries(PLANTILLAS_META).map(([key, val]) => ({
    nombre_meta: key,
    label: val.label,
    icono: val.icono,
    producto: val.producto,
    vars: val.vars,
    botones: val.botones
  }));
  return Response.json({ success: true, plantillas: lista });
}