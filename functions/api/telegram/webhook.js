// functions/api/telegram/webhook.js
// Comandos de Eduardo desde Telegram:
//   /pago_confirmado 507XXXXXXXX   → bienvenida al cliente
//   /pausar 507XXXXXXXX            → Kairós deja de responder, Eduardo toma control
//   /reanudar 507XXXXXXXX          → Kairós retoma el control
//   /decir 507XXXXXXXX [mensaje]   → Eduardo envía mensaje al cliente (modo manual)

const MENSAJE_BIENVENIDA = `¡Bienvenido/a a TechZone! 🎉

Su proyecto ha sido confirmado. Para iniciar el diseño necesito:

1) ¿Prefiere la Tienda Completa o Landing Estacional?
2) ¿Tiene logo? Si sí, por favor envíelo por aquí
3) ¿Colores preferidos o referencia de diseño?

Eduardo iniciará el diseño en las próximas 24 horas.`;

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

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const update = await request.json();
    const message = update.message;

    if (!message?.text) return Response.json({ ok: true });

    const chatId  = message.chat.id;
    const texto   = message.text.trim();
    const partes  = texto.split(/\s+/);
    const comando = partes[0].toLowerCase();

    // ── /pago_confirmado 507XXXXXXXX ──────────────────────────────────────
    if (comando === "/pago_confirmado") {
      const numeroRaw = partes[1] || "";
      if (!numeroRaw) {
        await responderTelegram(env, chatId, "⚠️ Uso: <code>/pago_confirmado 507XXXXXXXX</code>");
        return Response.json({ ok: true });
      }
      const numero = numeroRaw.replace(/\D/g, "");
      if (numero.length < 8) {
        await responderTelegram(env, chatId, `⚠️ Número inválido: <code>${numeroRaw}</code>`);
        return Response.json({ ok: true });
      }

      // Buscar nombre en D1
      let nombreCliente = null;
      try {
        const result = await env.kairos_db.prepare(
          "SELECT nombre FROM Prospectos WHERE whatsapp LIKE ? OR whatsapp LIKE ? LIMIT 1"
        ).bind(`%${numero}%`, `+${numero}`).all();
        if (result.results?.length > 0) nombreCliente = result.results[0].nombre;
      } catch(e) {}

      // Enviar bienvenida
      const waResult = await enviarMensajeWA(env, numero, MENSAJE_BIENVENIDA);
      if (waResult.error) {
        await responderTelegram(env, chatId, `❌ Meta rechazó el mensaje\n\nError: ${waResult.error.message || JSON.stringify(waResult.error)}`);
        return Response.json({ ok: true });
      }

      // Actualizar D1
      try {
        await env.kairos_db.prepare(
          "UPDATE Prospectos SET estado = 'pagado' WHERE whatsapp LIKE ? OR whatsapp LIKE ?"
        ).bind(`%${numero}%`, `+${numero}`).run();
        await env.kairos_db.prepare(
          "INSERT INTO Conversaciones_WA (numero, rol, contenido, fecha) VALUES (?, ?, ?, ?)"
        ).bind(numero, "assistant", MENSAJE_BIENVENIDA, new Date().toISOString()).run();
      } catch(e) {}

      const nombreDisplay = nombreCliente ? ` (${nombreCliente})` : "";
      await responderTelegram(env, chatId,
        `✅ <b>Bienvenida enviada</b>\n\nCliente: <code>+${numero}</code>${nombreDisplay}\n📌 Estado: <b>pagado</b>\n\nKairós tomará el control del chat de bienvenida. 🎉`
      );
      return Response.json({ ok: true });
    }

    // ── /pausar 507XXXXXXXX ───────────────────────────────────────────────
    if (comando === "/pausar") {
      const numeroRaw = partes[1] || "";
      if (!numeroRaw) {
        await responderTelegram(env, chatId, "⚠️ Uso: <code>/pausar 507XXXXXXXX</code>");
        return Response.json({ ok: true });
      }
      const numero = numeroRaw.replace(/\D/g, "");
      try {
        await env.kairos_db.prepare(
          "CREATE TABLE IF NOT EXISTS Modos_Manual (numero TEXT PRIMARY KEY, fecha TEXT)"
        ).run();
        await env.kairos_db.prepare(
          "INSERT OR REPLACE INTO Modos_Manual (numero, fecha) VALUES (?, ?)"
        ).bind(numero, new Date().toISOString()).run();
      } catch(e) {
        await responderTelegram(env, chatId, `❌ Error: ${e.message}`);
        return Response.json({ ok: true });
      }
      await responderTelegram(env, chatId,
        `🎮 <b>Modo manual activado</b>\n\nCliente: <code>+${numero}</code>\n\nKairós está pausado. Usa:\n<code>/decir ${numero} [tu mensaje]</code>\n\nCuando termines:\n<code>/reanudar ${numero}</code>`
      );
      return Response.json({ ok: true });
    }

    // ── /reanudar 507XXXXXXXX ─────────────────────────────────────────────
    if (comando === "/reanudar") {
      const numeroRaw = partes[1] || "";
      if (!numeroRaw) {
        await responderTelegram(env, chatId, "⚠️ Uso: <code>/reanudar 507XXXXXXXX</code>");
        return Response.json({ ok: true });
      }
      const numero = numeroRaw.replace(/\D/g, "");
      try {
        await env.kairos_db.prepare(
          "DELETE FROM Modos_Manual WHERE numero = ?"
        ).bind(numero).run();
      } catch(e) {
        await responderTelegram(env, chatId, `❌ Error: ${e.message}`);
        return Response.json({ ok: true });
      }
      await responderTelegram(env, chatId,
        `🤖 <b>Kairós reactivado</b>\n\nCliente: <code>+${numero}</code>\n\nKairós retoma el control del chat. ✅`
      );
      return Response.json({ ok: true });
    }

    // ── /decir 507XXXXXXXX [mensaje] ──────────────────────────────────────
    if (comando === "/decir") {
      const numeroRaw = partes[1] || "";
      const mensajeTexto = partes.slice(2).join(" ");

      if (!numeroRaw || !mensajeTexto) {
        await responderTelegram(env, chatId, "⚠️ Uso: <code>/decir 507XXXXXXXX Hola, soy Eduardo...</code>");
        return Response.json({ ok: true });
      }
      const numero = numeroRaw.replace(/\D/g, "");

      // Verificar que está en modo manual
      let enModoManual = false;
      try {
        const row = await env.kairos_db.prepare(
          "SELECT 1 FROM Modos_Manual WHERE numero = ? LIMIT 1"
        ).bind(numero).first();
        enModoManual = !!row;
      } catch(e) {}

      if (!enModoManual) {
        await responderTelegram(env, chatId,
          `⚠️ El cliente <code>+${numero}</code> no está en modo manual.\n\nPrimero ejecuta:\n<code>/pausar ${numero}</code>`
        );
        return Response.json({ ok: true });
      }

      // Enviar mensaje al cliente
      const waResult = await enviarMensajeWA(env, numero, mensajeTexto);
      if (waResult.error) {
        await responderTelegram(env, chatId, `❌ Error enviando mensaje: ${waResult.error.message || JSON.stringify(waResult.error)}`);
        return Response.json({ ok: true });
      }

      // Guardar en historial para que Kairós tenga contexto cuando retome
      try {
        await env.kairos_db.prepare(
          "INSERT INTO Conversaciones_WA (numero, rol, contenido, fecha) VALUES (?, ?, ?, ?)"
        ).bind(numero, "assistant", `[Eduardo] ${mensajeTexto}`, new Date().toISOString()).run();
      } catch(e) {}

      await responderTelegram(env, chatId,
        `✅ <b>Mensaje enviado</b>\n\n📱 <code>+${numero}</code>\n💬 "${mensajeTexto}"`
      );
      return Response.json({ ok: true });
    }

    // ── Comando desconocido ───────────────────────────────────────────────
    await responderTelegram(env, chatId,
      `🤖 <b>Kairós — Comandos disponibles</b>\n\n<code>/pago_confirmado 507XX</code> — Confirmar pago y enviar bienvenida\n<code>/pausar 507XX</code> — Tomar control de la conversación\n<code>/decir 507XX [mensaje]</code> — Enviar mensaje al cliente\n<code>/reanudar 507XX</code> — Devolver control a Kairós`
    );
    return Response.json({ ok: true });

  } catch (error) {
    console.error("Error en webhook Telegram:", error.message);
    return Response.json({ ok: true });
  }
}