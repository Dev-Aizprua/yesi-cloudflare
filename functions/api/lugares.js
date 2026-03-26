export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { query } = await request.json();

    // REGLA 1: Siempre forzar Panamá en el query
    const searchQuery = `${query}, Panama`;
    console.log(`Buscando en Google Maps: "${searchQuery}"`);

    // Endpoint síncrono: Apify corre el Actor y devuelve resultados directamente
    // Sin polling — Apify espera en su lado y nos manda los datos cuando termina
    const res = await fetch(`https://api.apify.com/v2/acts/2Mdma1N6Fd0y3QEjR/run-sync-get-dataset-items?token=${env.APIFY_TOKEN}&timeout=55&memory=256`, {
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

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('Error Apify:', JSON.stringify(err));
      return Response.json({ success: false, error: 'Error en búsqueda de Google Maps' }, { status: 500 });
    }

    const items = await res.json();

    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ success: false, error: 'No se encontraron resultados en Panamá' }, { status: 404 });
    }

    // REGLA 2: Filtrar resultados fuera de Panamá
    const lugaresFiltrados = items
      .filter(p => {
        const pais = (p.country || p.countryCode || '').toUpperCase();
        const direccion = (p.address || '').toLowerCase();
        if (pais && pais !== 'PA' && pais !== 'PANAMA' && pais !== 'PANAMÁ') return false;
        const paisesExcluir = ['españa', 'spain', 'colombia', 'chile', 'mexico', 'argentina', 'costa rica'];
        if (paisesExcluir.some(x => direccion.includes(x))) return false;
        return true;
      })
      .slice(0, 10)
      // REGLA 3: null donde no hay dato — el LLM NO debe inventar
      .map((p, index) => ({
        numero: index + 1,
        nombre: p.title || p.name || 'No disponible',
        direccion: p.address || p.street || 'No disponible',
        telefono: p.phone || p.phoneUnformatted || null,
        sitio_web: p.website || null,
        categoria: p.categoryName || p.categories?.[0] || 'No disponible',
        rating: p.totalScore || p.rating || null,
        resenas: p.reviewsCount || null,
        tiene_web: !!(p.website),
        pais_verificado: 'PA',
        fuente: 'google_maps'
      }));

    if (lugaresFiltrados.length === 0) {
      return Response.json({
        success: false,
        error: 'No se encontraron resultados verificados en Panamá.'
      }, { status: 404 });
    }

    console.log(`Google Maps: ${items.length} resultados → ${lugaresFiltrados.length} verificados en Panamá`);

    return Response.json({
      success: true,
      lugares: lugaresFiltrados,
      fuente: 'apify_google_maps',
      total_bruto: items.length,
      total_filtrado: lugaresFiltrados.length
    });

  } catch (error) {
    console.error('Error en lugares:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}