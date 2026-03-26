export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { query } = await request.json();

    // Agregar "website" para traer solo negocios con web registrada
    const searchQuery = `${query}, Panama website`;
    console.log(`Buscando en Google Maps: "${searchQuery}"`);

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

    // Filtrar resultados fuera de Panama
    const itemsFiltrados = items.filter(p => {
      const pais = (p.country || p.countryCode || '').toUpperCase();
      const direccion = (p.address || '').toLowerCase();
      if (pais && pais !== 'PA' && pais !== 'PANAMA') return false;
      const excluir = ['espana', 'spain', 'colombia', 'chile', 'mexico', 'argentina', 'costa rica'];
      if (excluir.some(x => direccion.includes(x))) return false;
      return true;
    }).slice(0, 5);

    if (itemsFiltrados.length === 0) {
      return Response.json({ success: false, error: 'No se encontraron resultados verificados en Panama.' }, { status: 404 });
    }

    // Normalizar — sin Contact Scraper, correo se extrae después bajo demanda
    const lugares = itemsFiltrados.map((p, index) => ({
      numero: index + 1,
      nombre: p.title || p.name || 'No disponible',
      direccion: p.address || p.street || 'No disponible',
      telefono: p.phone || p.phoneUnformatted || null,
      sitio_web: (p.website && p.website !== 'undefined') ? p.website : null,
      correo: null, // Se extrae después con /api/contacto
      categoria: p.categoryName || p.categories?.[0] || 'No disponible',
      rating: p.totalScore || p.rating || null,
      resenas: p.reviewsCount || null,
      tiene_web: !!(p.website && p.website !== 'undefined'),
      pais_verificado: 'PA',
      fuente: 'google_maps'
    }));

    console.log(`Google Maps: ${items.length} resultados -> ${lugares.length} verificados en Panama`);
    console.log(`Con sitio web: ${lugares.filter(l => l.tiene_web).length}`);

    return Response.json({
      success: true,
      lugares,
      fuente: 'apify_google_maps',
      total_bruto: items.length,
      total_filtrado: lugares.length,
      con_web: lugares.filter(l => l.tiene_web).length
    });

  } catch (error) {
    console.error('Error en lugares:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}