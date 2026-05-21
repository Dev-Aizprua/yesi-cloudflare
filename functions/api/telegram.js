// ─── TELEGRAM — Notificaciones salientes + Webhook de comandos ────────────────
//
// POST /api/telegram         → enviar notificación desde el sistema a Eduardo
// POST /api/telegram/webhook → recibir comandos de Eduardo desde Telegram
//
// Comandos disponibles:
//   /pago_confirmado 507XXXXXXXX  → bienvenida al cliente y solicitud de datos

// ─── MENSAJE DE BIENVENIDA POST-PAGO ────────────────────────────────────────
const MENSAJE_BIENVENIDA = `¡Bienvenido/a a TechZone! 🎉

Su proyecto ha sido confirmado. Para iniciar el diseño necesito:

1) ¿Prefiere la Tienda Completa o Landing Estacional?
2) ¿Tiene logo? Si sí, por favor envíelo por aquí
3) ¿Colores preferidos o referencia de diseño?

Eduardo iniciará el diseño en las próximas 24 horas.`;

// ─── ENVIAR MENSAJE DE WHATSAPP ──────────────────────────────────────────────
async function enviarMensajeWA(env, to, texto) {
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
  return res.json();
}

// ─── RESPONDER A TELEGRAM ─────────────────────────────────────────────────────
async function responderTelegram(env, chatId, texto) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: texto,
      parse_mode: "HTML"
    })
  });
}

// ─── WEBHOOK DE TELEGRAM (comandos de Eduardo) ───────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // ── Ruta /api/telegram/webhook — recibe updates de Telegram ──────────────
  if (url.pathname.endsWith("/webhook")) {
    try {
      const update = await request.json();
      const message = update.message;

      if (!message?.text) {
        return Response.json({ ok: true });
      }

      const chatId   = message.chat.id;
      const texto    = message.text.trim();
      const partes   = texto.split(/\s+/);
      const comando  = partes[0].toLowerCase();

      // ── /pago_confirmado 507XXXXXXXX ───────────────────────────────────────
      if (comando === "/pago_confirmado") {
        const numeroRaw = partes[1] || "";

        if (!numeroRaw) {
          await responderTelegram(env, chatId,
            "⚠️ Uso correcto: <code>/pago_confirmado 507XXXXXXXX</code>\n\nEjemplo: <code>/pago_confirmado 50766778899</code>"
          );
          return Response.json({ ok: true });
        }

        // Normalizar número — quitar + y espacios, conservar solo dígitos
        const numero = numeroRaw.replace(/\D/g, "");

        if (numero.length < 8) {
          await responderTelegram(env, chatId,
            `⚠️ Número inválido: <code>${numeroRaw}</code>\n\nDebe incluir el código de país. Ejemplo: <code>/pago_confirmado 50766778899</code>`
          );
          return Response.json({ ok: true });
        }

        // 1. Buscar el prospecto en D1 para obtener su nombre
        let nombreCliente = null;
        try {
          const result = await env.kairos_db.prepare(
            "SELECT nombre FROM Prospectos WHERE whatsapp LIKE ? OR whatsapp LIKE ? LIMIT 1"
          ).bind(`%${numero}%`, `+${numero}`).all();
          if (result.results?.length > 0) {
            nombreCliente = result.results[0].nombre;
          }
        } catch(e) {
          console.log("Error buscando prospecto en D1:", e.message);
        }

        // 2. Enviar mensaje de bienvenida al cliente por WhatsApp
        let waResult;
        try {
          waResult = await enviarMensajeWA(env, numero, MENSAJE_BIENVENIDA);
        } catch(e) {
          await responderTelegram(env, chatId,
            `❌ Error enviando WhatsApp al <code>+${numero}</code>\n\n${e.message}`
          );
          return Response.json({ ok: true });
        }

        if (waResult.error) {
          await responderTelegram(env, chatId,
            `❌ Meta rechazó el mensaje al <code>+${numero}</code>\n\nError: ${waResult.error.message || JSON.stringify(waResult.error)}`
          );
          return Response.json({ ok: true });
        }

        // 3. Actualizar estado del prospecto en D1
        try {
          await env.kairos_db.prepare(
            `UPDATE Prospectos SET estado = 'pagado' WHERE whatsapp LIKE ? OR whatsapp LIKE ?`
          ).bind(`%${numero}%`, `+${numero}`).run();
        } catch(e) {
          console.log("Error actualizando estado en D1:", e.message);
        }

        // 4. Registrar en Conversaciones_WA para que Kairós tenga contexto
        try {
          const fecha = new Date().toISOString();
          await env.kairos_db.prepare(
            "INSERT INTO Conversaciones_WA (numero, rol, contenido, fecha) VALUES (?, ?, ?, ?)"
          ).bind(numero, "assistant", MENSAJE_BIENVENIDA, fecha).run();
        } catch(e) {
          console.log("Error guardando bienvenida en historial:", e.message);
        }

        // 5. Confirmar a Eduardo en Telegram
        const nombreDisplay = nombreCliente ? ` (${nombreCliente})` : "";
        await responderTelegram(env, chatId,
          `✅ <b>Bienvenida enviada</b>\n\nCliente: <code>+${numero}</code>${nombreDisplay}\n📌 Estado: <b>pagado</b>\n\nKairós tomará el control del chat de bienvenida. 🎉`
        );

        return Response.json({ ok: true });
      }

      // ── Comando desconocido ───────────────────────────────────────────────
      await responderTelegram(env, chatId,
        "🤖 <b>Kairós — Comandos disponibles</b>\n\n<code>/pago_confirmado 507XXXXXXXX</code> — Confirmar pago y enviar bienvenida al cliente"
      );
      return Response.json({ ok: true });

    } catch (error) {
      console.error("Error en webhook Telegram:", error.message);
      return Response.json({ ok: true }); // Telegram requiere 200 siempre
    }
  }

  // ── Ruta /api/telegram — notificaciones salientes del sistema ────────────
  try {
    const { mensaje } = await request.json();

    if (!mensaje) {
      return Response.json({ success: false, error: 'Falta el mensaje' }, { status: 400 });
    }

    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: mensaje,
        parse_mode: 'HTML'
      })
    });

    const data = await res.json();

    if (!data.ok) {
      console.error('Error Telegram:', JSON.stringify(data));
      return Response.json({ success: false, error: data.description }, { status: 500 });
    }

    return Response.json({ success: true });

  } catch (error) {
    console.error('Error en telegram:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}