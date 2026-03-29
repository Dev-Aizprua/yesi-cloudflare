export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { query } = await request.json();

    const searchQuery = `${query}, Panama`;
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
    });

    if (itemsFiltrados.length === 0) {
      return Response.json({ success: false, error: 'No se encontraron resultados verificados en Panama.' }, { status: 404 });
    }

    // ─── ALGORITMO DE SCORING ────────────────────────────────────
    function calcularScore(p) {
      let score = 0;
      const tiene_web = !!(p.website && p.website !== 'undefined' && p.website !== 'null');
      const resenas = p.reviewsCount || 0;
      const rating = p.totalScore || p.rating || 0;
      const telefono = p.phone || p.phoneUnformatted || null;

      if (!tiene_web) score += 30;       // Sin web = oportunidad de oro
      if (resenas > 50) score += 30;     // Tiene flujo de clientes
      if (rating > 4.2) score += 20;     // Cuida su marca
      if (telefono) score += 20;         // Facilidad de cierre

      return score;
    }

    function clasificar(score) {
      if (score >= 70) return { emoji: '🐋', label: 'Pez Gordo' };
      if (score >= 40) return { emoji: '🐟', label: 'Interesante' };
      return { emoji: '⭕', label: 'Descartar' };
    }

    // Normalizar, calcular score y ordenar
    const lugares = itemsFiltrados
      .map(p => {
        const tiene_web = !!(p.website && p.website !== 'undefined' && p.website !== 'null');
        const score = calcularScore(p);
        const clasificacion = clasificar(score);

        return {
          nombre: p.title || p.name || 'No disponible',
          direccion: p.address || p.street || 'No disponible',
          telefono: p.phone || p.phoneUnformatted || null,
          sitio_web: tiene_web ? p.website : null,
          correo: null,
          categoria: p.categoryName || p.categories?.[0] || 'No disponible',
          rating: p.totalScore || p.rating || null,
          resenas: p.reviewsCount || null,
          tiene_web,
          score,
          scoring: clasificacion.label,  // 'Pez Gordo', 'Interesante', 'Descartar'
          prioridad: clasificacion.emoji,
          clasificacion: clasificacion.label,
          pais_verificado: 'PA',
          fuente: 'google_maps'
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((p, index) => ({ numero: index + 1, ...p }));

    const pezGordo = lugares.filter(l => l.scoring === 'Pez Gordo').length;
    const interesante = lugares.filter(l => l.scoring === 'Interesante').length;
    const descartar = lugares.filter(l => l.scoring === 'Descartar').length;

    console.log(`Scoring: ${pezGordo} Pez Gordo | ${interesante} Interesante | ${descartar} Descartar`);
    console.log(`Google Maps: ${items.length} -> ${lugares.length} verificados en Panama`);

    return Response.json({
      success: true,
      lugares,
      fuente: 'apify_google_maps',
      total_bruto: items.length,
      total_filtrado: lugares.length,
      scoring: { pez_gordo: pezGordo, interesante, descartar }
    });

  } catch (error) {
    console.error('Error en lugares:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}