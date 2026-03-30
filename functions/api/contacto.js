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
    let whatsappDirecto = null;
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

        // Regex estricto para emails válidos — evita falsos positivos de URLs
        const emailRegex = /\b[a-zA-Z0-9._%+\-]{2,}@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6}\b/g;
        const matches = html.match(emailRegex) || [];

        // Filtrar correos basura, falsos positivos y correos de agencias/hosting
        const dominiosAgencia = [
          'webstudio', 'hosting', 'wix', 'wordpress', 'squarespace',
          'godaddy', 'bluehost', 'siteground', 'namecheap', 'hostgator',
          'agencia', 'developer', 'devops', 'studio', 'solutions'
        ];

        const filtrados = matches.filter(e => {
          const partes = e.split('@');
          if (partes.length !== 2) return false;
          const [usuario, dominio] = partes;
          if (/^\d+-/.test(usuario)) return false;
          if (!dominio.includes('.')) return false;
          const ext = dominio.split('.').pop().toLowerCase();
          if (['html','php','js','css','png','jpg','gif','svg','xml','json'].includes(ext)) return false;
          if (e.includes('noreply') || e.includes('no-reply') ||
              e.includes('example.com') || e.includes('sentry') ||
              e.includes('wixpress') || e.includes('schema.org')) return false;
          // Filtrar correos de agencias web y proveedores de hosting
          if (dominiosAgencia.some(p => e.toLowerCase().includes(p))) return false;
          return true;
        });

        // Deduplicar y tomar el primero
        const unicos = [...new Set(filtrados)];
        if (unicos.length > 0) {
          correoDirecto = unicos[0];
          console.log(`Scraper directo encontró correo: ${correoDirecto}`);
        }

        // Buscar WhatsApp en el HTML — patrones wa.me/507... o api.whatsapp.com/send?phone=507...
        const waPatterns = [
          /wa\.me\/(507\d{7,8})/,
          /api\.whatsapp\.com\/send\?phone=(507\d{7,8})/,
          /whatsapp\.com\/send\?phone=(507\d{7,8})/,
          /wa\.me\/(\d{10,12})/,
        ];
        for (const pattern of waPatterns) {
          const waMatch = html.match(pattern);
          if (waMatch) {
            whatsappDirecto = '+' + waMatch[1];
            console.log(`Scraper directo encontró WhatsApp: ${whatsappDirecto}`);
            break;
          }
        }
      }
    } catch(e) {
      console.log(`Scraper directo falló (bloqueado o timeout): ${e.message}`);
    }

    // ─── Si encontró correo o WhatsApp directo — responde inmediatamente ─────
    if (correoDirecto || whatsappDirecto) {
      return Response.json({
        success: true,
        correo: correoDirecto,
        whatsapp: whatsappDirecto,
        sitio_web,
        metodo: 'directo'
      });
    }

    // ─── NIVEL 2: LANZAR VDRMOTA EN BACKGROUND ───────────────────
    // SIEMPRE se lanza cuando scraper directo no encuentra correo válido
    console.log(`⚡ BACKGROUND ACTIVADO: Lanzando vdrmota para: ${sitio_web}`);

    try {
      const callbackUrl = `${new URL(request.url).origin}/api/contacto-callback`;
      console.log(`Webhook URL: ${callbackUrl}`);

      // Webhook sin payloadTemplate — Apify envía su payload default con resource.id real
      // Pasamos sitio_web y nombre en la URL como query params
      const encodedSitio = encodeURIComponent(sitio_web);
      const encodedNombre = encodeURIComponent(nombre || '');
      const callbackUrlConParams = `${callbackUrl}?sitio_web=${encodedSitio}&nombre=${encodedNombre}`;

      const webhookObj = [{
        eventTypes: ['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.TIMED_OUT'],
        requestUrl: callbackUrlConParams
      }];
      const webhookPayload = btoa(JSON.stringify(webhookObj));

      const runRes = await fetch(`https://api.apify.com/v2/acts/vdrmota~contact-info-scraper/runs?token=${env.APIFY_TOKEN_CONTACT}&memory=256&webhooks=${webhookPayload}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrls: [{ url: sitio_web }],
          maxDepth: 1,
          maxPagesPerStartUrl: 1,
          proxyConfiguration: { useApifyProxy: true }
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