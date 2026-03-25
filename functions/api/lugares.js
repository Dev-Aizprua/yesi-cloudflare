export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { query, ubicacion } = await request.json();

    // Construir búsqueda para Panamá
    const searchQuery = `${query} en Panamá`;

    // ─── STEP 1: Lanzar el Actor de Apify ───────────────────────
    const runRes = await fetch('https://api.apify.com/v2/acts/brujula~rastreador-google-places/runs', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.APIFY_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        searchStringsArray: [searchQuery],
        maxCrawledPlacesPerSearch: 10,
        language: 'es',
        countryCode: 'pa',
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

    if (!runId) {
      return Response.json({ success: false, error: 'No se obtuvo ID de ejecución' }, { status: 500 });
    }

    console.log(`Apify run iniciado: ${runId}`);

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
    const datasetId = runData.data?.defaultDatasetId;
    const resultsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?limit=10`, {
      headers: { 'Authorization': `Bearer ${env.APIFY_TOKEN}` }
    });

    const items = await resultsRes.json();

    if (!Array.isArray(items) || items.length === 0) {
      return Response.json({ success: false, error: 'No se encontraron resultados' }, { status: 404 });
    }

    // ─── STEP 4: Normalizar al mismo formato de Foursquare ───────
    const lugares = items.map((p, index) => ({
      numero: index + 1,
      nombre: p.title || p.name || '',
      direccion: p.address || p.street || '',
      telefono: p.phone || p.phoneUnformatted || '',
      sitio_web: p.website || '',
      categoria: p.categoryName || p.categories?.[0] || '',
      rating: p.totalScore || p.rating || null,
      resenas: p.reviewsCount || null,
      tiene_web: !!(p.website),
      fuente: 'google_maps'
    }));

    console.log(`Apify: ${lugares.length} lugares encontrados para "${searchQuery}"`);

    return Response.json({ success: true, lugares, fuente: 'apify_google_maps' });

  } catch (error) {
    console.error('Error en lugares:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}