export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { query } = await request.json();

    // REGLA: Siempre forzar Panama en el query
    const searchQuery = `${query}, Panama`;
    console.log(`Buscando en Google Maps: "${searchQuery}"`);

    // ─── STEP 1: Google Maps Scraper (Apify) ────────────────────
    const mapsRes = await fetch(`https://api.apify.com/v2/acts/2Mdma1N6Fd0y3QEjR/run-sync-get-dataset-items?token=${env.APIFY_TOKEN}&timeout=55&memory=256`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        searchStringsArray: [searchQuery],
        maxCrawledPlacesPerSearch: 5,
        language: 'es',
        countryCode: 'pa',
        locationQuery: 'Panama',
        includeWebResults: false,
      })
    });

    if (!mapsRes.ok) {
      const err = await mapsRes.json().catch(() => ({}));
      console.error('Error Google Maps:', JSON.stringify(err));
      return Response.json({ success: false, error: 'Error en busqueda de Google Maps' }, { status: 500 });
    }

    const items = await mapsRes.json();

    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ success: false, error: 'No se encontraron resultados en Panama' }, { status: 404 });
    }

    // ─── STEP 2: Filtrar resultados fuera de Panama ──────────────
    const itemsFiltrados = items.filter(p => {
      const pais = (p.country || p.countryCode || '').toUpperCase();
      const direccion = (p.address || '').toLowerCase();
      if (pais && pais !== 'PA' && pais !== 'PANAMA' && pais !== 'PANAMA') return false;
      const excluir = ['espana', 'spain', 'colombia', 'chile', 'mexico', 'argentina', 'costa rica'];
      if (excluir.some(x => direccion.includes(x))) return false;
      return true;
    }).slice(0, 5);

    if (itemsFiltrados.length === 0) {
      return Response.json({ success: false, error: 'No se encontraron resultados verificados en Panama.' }, { status: 404 });
    }

    console.log(`Google Maps: ${items.length} resultados -> ${itemsFiltrados.length} verificados en Panama`);

    // ─── STEP 3: Contact Details Scraper para webs ──────────────
    // Solo para negocios que tienen sitio web
    const websConWeb = itemsFiltrados
      .filter(p => p.website && p.website !== 'undefined')
      .map(p => p.website);

    let correosMap = {}; // { url: correo }

    if (websConWeb.length > 0) {
      try {
        console.log(`Extrayendo correos de ${websConWeb.length} sitios web...`);

        const contactRes = await fetch(`https://api.apify.com/v2/acts/9Sk4JJhEma9vBKqrg/run-sync-get-dataset-items?token=${env.APIFY_TOKEN_CONTACT}&timeout=50&memory=256`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            startUrls: websConWeb.map(url => ({ url })),
            maxDepth: 1,
            maxPagesPerStartUrl: 3,
            proxyConfiguration: { useApifyProxy: true }
          })
        });

        if (contactRes.ok) {
          const contactItems = await contactRes.json();
          if (Array.isArray(contactItems)) {
            contactItems.forEach(item => {
              const url = item.url || item.requestUrl || '';
              const emails = item.emails || [];
              if (emails.length > 0) {
                // Buscar el dominio base para hacer match con la web
                const dominio = websConWeb.find(w => url.includes(new URL(w).hostname));
                if (dominio) {
                  correosMap[dominio] = emails[0]; // Primer correo encontrado
                }
              }
            });
          }
          console.log(`Correos extraidos: ${Object.keys(correosMap).length}`);
        }
      } catch (e) {
        console.log('Contact scraper fallo (no critico):', e.message);
        // No es critico — continuamos sin correos
      }
    }

    // ─── STEP 4: Normalizar resultados finales ───────────────────
    const lugares = itemsFiltrados.map((p, index) => {
      const web = (p.website && p.website !== 'undefined') ? p.website : null;
      const correoEncontrado = web ? (correosMap[web] || null) : null;

      return {
        numero: index + 1,
        nombre: p.title || p.name || 'No disponible',
        direccion: p.address || p.street || 'No disponible',
        telefono: p.phone || p.phoneUnformatted || null,
        sitio_web: web,
        correo: correoEncontrado,
        categoria: p.categoryName || p.categories?.[0] || 'No disponible',
        rating: p.totalScore || p.rating || null,
        resenas: p.reviewsCount || null,
        tiene_web: !!web,
        tiene_correo: !!correoEncontrado,
        pais_verificado: 'PA',
        fuente: 'google_maps'
      };
    });

    console.log(`Resultado final: ${lugares.length} lugares | ${lugares.filter(l => l.tiene_correo).length} con correo`);

    return Response.json({
      success: true,
      lugares,
      fuente: 'apify_google_maps',
      total_bruto: items.length,
      total_filtrado: lugares.length,
      con_correo: lugares.filter(l => l.tiene_correo).length
    });

  } catch (error) {
    console.error('Error en lugares:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}