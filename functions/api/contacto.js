export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { sitio_web, nombre } = await request.json();

    if (!sitio_web) {
      return Response.json({ success: false, error: 'Se requiere sitio_web para extraer correo' }, { status: 400 });
    }

    console.log(`Extrayendo correo de: ${sitio_web} (${nombre})`);

    // ─── PASO 1: Lanzar el actor de forma asíncrona ───────────────
    const runRes = await fetch(`https://api.apify.com/v2/acts/vdrmota~contact-info-scraper/runs?token=${env.APIFY_TOKEN_CONTACT}&memory=256`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startUrls: [{ url: sitio_web }],
        maxDepth: 1,
        maxPagesPerStartUrl: 1,
        proxyConfiguration: { useApifyProxy: true }
      })
    });

    if (!runRes.ok) {
      const err = await runRes.json().catch(() => ({}));
      console.error('Error lanzando actor:', JSON.stringify(err));
      return Response.json({ success: true, correo: null, mensaje: 'No se pudo iniciar la búsqueda de contacto.' });
    }

    const runData = await runRes.json();
    const runId = runData?.data?.id;

    if (!runId) {
      return Response.json({ success: true, correo: null, mensaje: 'No se obtuvo ID del run.' });
    }

    console.log(`Run lanzado: ${runId} — esperando resultados...`);

    // ─── PASO 2: Polling cada 4s hasta 24s máximo ─────────────────
    const maxEspera = 24000;
    const intervalo = 4000;
    let elapsed = 0;
    let status = 'RUNNING';

    while (elapsed < maxEspera) {
      await new Promise(r => setTimeout(r, intervalo));
      elapsed += intervalo;

      const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${env.APIFY_TOKEN_CONTACT}`);
      const statusData = await statusRes.json();
      status = statusData?.data?.status;

      console.log(`Run ${runId} status: ${status} (${elapsed}ms)`);

      if (status === 'SUCCEEDED') break;
      if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
        return Response.json({ success: true, correo: null, mensaje: 'Búsqueda completada. No se encontró correo público.' });
      }
    }

    if (status !== 'SUCCEEDED') {
      console.log(`Run no completó a tiempo: ${status}`);
      return Response.json({ success: true, correo: null, mensaje: 'Búsqueda exitosa. No se encontró correo público en el sitio web.' });
    }

    // ─── PASO 3: Obtener resultados ───────────────────────────────
    const itemsRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${env.APIFY_TOKEN_CONTACT}`);
    const items = await itemsRes.json();

    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ success: true, correo: null, mensaje: 'Búsqueda exitosa. No se encontró correo público en el sitio web.' });
    }

    // ─── PASO 4: Buscar primer correo válido ──────────────────────
    let correoEncontrado = null;
    for (const item of items) {
      const emails = item.emails || [];
      if (emails.length > 0) {
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
      console.log(`Correo encontrado para ${nombre}: ${correoEncontrado}`);
      return Response.json({ success: true, correo: correoEncontrado, sitio_web });
    } else {
      console.log(`Sin correo para ${nombre}`);
      return Response.json({ success: true, correo: null, mensaje: 'Búsqueda exitosa. No se encontró correo público en el sitio web.' });
    }

  } catch (error) {
    console.error('Error en contacto:', error.message);
    return Response.json({ success: true, correo: null, mensaje: 'Error técnico al buscar contacto.' });
  }
}