export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { sitio_web, nombre } = await request.json();

    if (!sitio_web) {
      return Response.json({ success: false, error: 'Se requiere sitio_web para extraer correo' }, { status: 400 });
    }

    console.log(`Extrayendo correo de: ${sitio_web} (${nombre})`);

    const contactRes = await fetch(`https://api.apify.com/v2/acts/9Sk4JJhEma9vBKqrg/run-sync-get-dataset-items?token=${env.APIFY_TOKEN_CONTACT}&timeout=55&memory=256`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startUrls: [{ url: sitio_web }],
        maxDepth: 1,
        maxPagesPerStartUrl: 3,
        proxyConfiguration: { useApifyProxy: true }
      })
    });

    if (!contactRes.ok) {
      const err = await contactRes.json().catch(() => ({}));
      console.error('Error Contact Scraper:', JSON.stringify(err));
      return Response.json({ success: false, error: 'Error extrayendo contacto' }, { status: 500 });
    }

    const items = await contactRes.json();

    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ success: false, correo: null, mensaje: 'No se encontro correo en el sitio web' });
    }

    // Buscar primer correo válido
    let correoEncontrado = null;
    for (const item of items) {
      const emails = item.emails || [];
      if (emails.length > 0) {
        // Filtrar correos genéricos no útiles
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
      return Response.json({ success: false, correo: null, mensaje: 'No se encontro correo publico en el sitio web' });
    }

  } catch (error) {
    console.error('Error en contacto:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}