export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { query, ubicacion } = await request.json();

    // REGLA 1: Siempre forzar Panamá en el query
    const searchQuery = `${query}, Panama`;

    // ─── STEP 1: Lanzar el Actor de Apify ───────────────────────
    const runRes = await fetch('https://api.apify.com/v2/acts/brujula~rastreador-google-places/runs', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.APIFY_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        searchStringsArray: [searchQuery],
        maxCrawledPlacesPerSearch: 15, // Pedir más para compensar los que se filtran
        language: 'es',
        countryCode: 'pa',            // REGLA 1: Forzar país Panamá
        locationQuery: 'Panama',      // REGLA 1: Contexto geográfico adicional
        includeWebResults: false,
      })
    });

    if (!runRes.ok) {
      const err = await runRes.json().catch(() => ({}));
      console.error('Error lanzando Apify:', JSON.stringify(err));
      return Response.json({ success: false, error: 'Error iniciando búsqueda en Apify' }, { status: 500 });
    }

    const runData = await runRes.json();
    const runId = runData.data?.id;
    const datasetId = runData.data?.defaultDatasetId;

    if (!runId) {
      return Response.json({ success: false, error: 'No se obtuvo ID de ejecución' }, { status: 500 });
    }

    console.log(`Apify run iniciado: ${runId} | Query: "${searchQuery}"`);

    // ─── STEP 2: Esperar que termine (polling con timeout 25s) ───
    let status = 'RUNNING';
    let intentos = 0;
    const maxIntentos = 10;

    while (status === 'RUNNING' && intentos < maxIntentos) {
      await new Promise(r => setTimeout(r, 2500));
      intentos++;

      const statusRes = await fetch(`https://api.apify.com/v2/acts/brujula~rastreador-google-places/runs/${runId}`, {
        headers: { 'Authorization': `Bearer ${env.APIFY_TOKEN}` }
      });

      const statusData = await statusRes.json();
      status = statusData.data?.status || 'RUNNING';
      console.log(`Apify intento ${intentos}: ${status}`);
    }

    if (status !== 'SUCCEEDED') {
      return Response.json({ success: false, error: `Apify terminó con estado: ${status}` }, { status: 500 });
    }

    // ─── STEP 3: Obtener resultados del dataset ──────────────────
    const resultsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?limit=15`, {
      headers: { 'Authorization': `Bearer ${env.APIFY_TOKEN}` }
    });

    const items = await resultsRes.json();

    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ success: false, error: 'No se encontraron resultados en Panamá' }, { status: 404 });
    }

    // ─── STEP 4: Filtrar y normalizar ───────────────────────────
    const lugaresFiltrados = items
      // REGLA 2: Descartar resultados que no sean de Panamá
      .filter(p => {
        const pais = (p.country || p.countryCode || '').toUpperCase();
        const direccion = (p.address || '').toLowerCase();
        // Si tiene código de país y no es PA, descartar
        if (pais && pais !== 'PA' && pais !== 'PANAMA' && pais !== 'PANAMÁ') return false;
        // Si la dirección menciona otro país conocido, descartar
        const paisesExcluir = ['españa', 'spain', 'colombia', 'chile', 'mexico', 'argentina', 'costa rica'];
        if (paisesExcluir.some(x => direccion.includes(x))) return false;
        return true;
      })
      .slice(0, 10)
      // REGLA 3: Mapear con null donde no hay dato (el LLM NO debe inventar)
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
        error: 'No se encontraron resultados verificados en Panamá. Intenta con otro término de búsqueda.'
      }, { status: 404 });
    }

    console.log(`Apify: ${items.length} resultados → ${lugaresFiltrados.length} verificados en Panamá para "${searchQuery}"`);

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