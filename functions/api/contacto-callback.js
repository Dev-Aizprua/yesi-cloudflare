export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const url = new URL(request.url);

    // sitio_web y nombre vienen en query params
    const sitio_web = url.searchParams.get('sitio_web') || 'Sin URL';
    const nombre = url.searchParams.get('nombre') || '';

    // runId viene en el payload default de Apify
    const runId = body?.resource?.id || body?.data?.id || body?.runId;
    const status = body?.eventType || body?.status || '';

    console.log(`Callback recibido: runId=${runId} status=${status} sitio=${sitio_web}`);

    if (!runId) {
      console.log('Sin runId — no se puede obtener resultado');
      await notificarTelegram(env,
        `⚠️ <b>Callback sin runId</b>\n\nSitio: ${sitio_web}\nBody: ${JSON.stringify(body).substring(0, 200)}`
      );
      return Response.json({ success: true });
    }

    // Si el run falló o hizo timeout
    if (status.includes('FAILED') || status.includes('TIMED_OUT')) {
      await notificarTelegram(env,
        `⚠️ <b>Búsqueda sin resultado</b>\n\nNegocio: ${nombre || sitio_web}\nSitio: ${sitio_web}\nEstado: Sin correo público encontrado`
      );
      return Response.json({ success: true });
    }

    // Obtener resultados del dataset
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
      await notificarTelegram(env,
        `📧 <b>Correo encontrado</b>\n\n` +
        `Negocio: ${nombre || 'Sin nombre'}\n` +
        `Sitio: ${sitio_web}\n` +
        `Correo: <code>${correoEncontrado}</code>\n\n` +
        `💡 Agrégalo en el Panel de Kairós`
      );
    } else {
      await notificarTelegram(env,
        `🔍 <b>Búsqueda completada — sin correo público</b>\n\n` +
        `Negocio: ${nombre || 'Sin nombre'}\n` +
        `Sitio: ${sitio_web}\n` +
        `Resultado: No tiene correo público visible`
      );
    }

    return Response.json({ success: true });

  } catch (error) {
    console.error('Error en contacto-callback:', error.message);
    return Response.json({ success: false, error: error.message });
  }
}

async function notificarTelegram(env, mensaje) {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
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