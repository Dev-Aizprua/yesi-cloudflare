export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { sitio_web, nombre } = await request.json();

    if (!sitio_web) {
      return Response.json({ success: false, error: 'Se requiere sitio_web para extraer correo' }, { status: 400 });
    }

    console.log(`Extrayendo correo de: ${sitio_web} (${nombre})`);

    // ─── NIVEL 1: SCRAPER DIRECTO (3-5s, gratis) ─────────────────
    let correoDirecto = null;
    try {
      const htmlRes = await fetch(sitio_web, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-PA,es;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(8000) // 8s máximo
      });

      if (htmlRes.ok) {
        const html = await htmlRes.text();

        // Regex para emails válidos — evita falsos positivos
        const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
        const matches = html.match(emailRegex) || [];

        // Filtrar correos basura
        const filtrados = matches.filter(e =>
          !e.includes('noreply') &&
          !e.includes('no-reply') &&
          !e.includes('example.com') &&
          !e.includes('sentry') &&
          !e.includes('wixpress') &&
          !e.includes('schema.org') &&
          !e.includes('.png') &&
          !e.includes('.jpg') &&
          !e.includes('.gif') &&
          !e.endsWith('.js') &&
          !e.endsWith('.css') &&
          e.includes('.')
        );

        // Deduplicar y tomar el primero
        const unicos = [...new Set(filtrados)];
        if (unicos.length > 0) {
          correoDirecto = unicos[0];
          console.log(`Scraper directo encontró: ${correoDirecto}`);
        }
      }
    } catch(e) {
      console.log(`Scraper directo falló (bloqueado o timeout): ${e.message}`);
    }

    // ─── Si encontró correo directo — responde inmediatamente ─────
    if (correoDirecto) {
      return Response.json({
        success: true,
        correo: correoDirecto,
        sitio_web,
        metodo: 'directo'
      });
    }

    // ─── NIVEL 2: LANZAR VDRMOTA EN BACKGROUND ───────────────────
    // No esperamos — lanzamos y notificamos por Telegram cuando llegue
    console.log(`Scraper directo sin resultado. Lanzando vdrmota en background para: ${sitio_web}`);

    try {
      const runRes = await fetch(`https://api.apify.com/v2/acts/vdrmota~contact-info-scraper/runs?token=${env.APIFY_TOKEN_CONTACT}&memory=256`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrls: [{ url: sitio_web }],
          maxDepth: 1,
          maxPagesPerStartUrl: 1,
          proxyConfiguration: { useApifyProxy: true },
          // Webhook: cuando termine, llama a nuestro endpoint
          webhooks: [{
            eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.TIMED_OUT'],
            requestUrl: `${new URL(request.url).origin}/api/contacto-callback`,
            payloadTemplate: `{"runId":"{{resource.id}}","sitio_web":"${sitio_web}","nombre":"${nombre || ''}","status":"{{eventType}}"}`
          }]
        })
      });

      if (runRes.ok) {
        const runData = await runRes.json();
        const runId = runData?.data?.id;
        console.log(`vdrmota lanzado en background. RunId: ${runId}`);
      }
    } catch(e) {
      console.log(`Error lanzando vdrmota: ${e.message}`);
    }

    // Responder inmediatamente sin bloquear
    return Response.json({
      success: true,
      correo: null,
      sitio_web,
      metodo: 'background',
      mensaje: 'Búsqueda profunda iniciada. Resultado llegará por Telegram en ~2 minutos.'
    });

  } catch (error) {
    console.error('Error en contacto:', error.message);
    return Response.json({ success: true, correo: null, mensaje: 'Error técnico al buscar contacto.' });
  }
}