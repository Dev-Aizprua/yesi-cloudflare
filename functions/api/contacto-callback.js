export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    // Apify puede enviar el runId en distintos campos según la versión
    const runId = body.runId || body.resource?.id || body.actorRunId;
    const sitio_web = body.sitio_web || 'Sin URL';
    const nombre = body.nombre || '';
    const status = body.status || body.eventType || '';

    console.log(`Callback recibido: runId=${runId} status=${status} sitio=${sitio_web}`);
    console.log(`Body completo: ${JSON.stringify(body)}`);

    // Si el run falló o hizo timeout
    if (!runId || status === 'ACTOR.RUN.FAILED' || status === 'ACTOR.RUN.TIMED_OUT') {
      await notificarTelegram(env, `⚠️ <b>Búsqueda de correo sin resultado</b>\n\nNegocio: ${nombre || sitio_web}\nSitio: ${sitio_web}\nEstado: Sin correo público encontrado`);
      return Response.json({ success: true });
    }

    // Si el run fue exitoso — obtener resultados
    if (status === 'ACTOR.RUN.SUCCEEDED') {
      const itemsRes = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${env.APIFY_TOKEN_CONTACT}`
      );
      const items = await itemsRes.json();

      let correoEncontrado = null;

      if (Array.isArray(items) && items.length > 0) {
        for (const item of items) {
          const emails = item.emails || [];
          const emailFiltrado = emails.find(e =>
            !e.includes('noreply') &&
            !e.includes('no-reply') &&
            !e.includes('example.com') &&
            !e.includes('sentry')
          );
          if (emailFiltrado) {
            correoEncontrado = emailFiltrado;
            break;
          }
        }
      }

      if (correoEncontrado) {
        // ✅ Correo encontrado — notificar con el dato listo para copiar
        await notificarTelegram(env,
          `📧 <b>Correo encontrado</b>\n\n` +
          `Negocio: ${nombre || 'Sin nombre'}\n` +
          `Sitio: ${sitio_web}\n` +
          `Correo: <code>${correoEncontrado}</code>\n\n` +
          `💡 Copia el correo y agrégalo en el Panel de Kairós`
        );
      } else {
        // Sin correo — notificar limpiamente
        await notificarTelegram(env,
          `🔍 <b>Búsqueda completada — sin correo público</b>\n\n` +
          `Negocio: ${nombre || 'Sin nombre'}\n` +
          `Sitio: ${sitio_web}\n` +
          `Resultado: No tiene correo público visible`
        );
      }
    }

    return Response.json({ success: true });

  } catch (error) {
    console.error('Error en contacto-callback:', error.message);
    return Response.json({ success: false, error: error.message });
  }
}

async function notificarTelegram(env, mensaje) {
  try {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: mensaje,
        parse_mode: 'HTML'
      })
    });
    console.log('Telegram notificado');
  } catch(e) {
    console.log('Error Telegram:', e.message);
  }
}