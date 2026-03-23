export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { query, ubicacion } = await request.json();

    const coords = ubicacion || '8.9936,-79.5197';

    const url = `https://places-api.foursquare.com/places/search?query=${encodeURIComponent(query)}&ll=${coords}&radius=10000&limit=10&fields=name,location,tel,website,categories`;

    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${env.FOURSQUARE_API_KEY}`,
        'Accept': 'application/json',
        'X-Places-Api-Version': '2025-06-17'
      }
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Error Foursquare:', JSON.stringify(data));
      return Response.json({ success: false, error: data.message || 'Error en Foursquare' }, { status: 500 });
    }

    const lugares = (data.results || []).map(p => ({
      nombre: p.name || '',
      direccion: p.location?.formatted_address || '',
      telefono: p.tel || '',
      sitio_web: p.website || '',
      categoria: p.categories?.[0]?.name || '',
    }));

    // Guardar en D1 los que no tienen web — oportunidades de venta
    let guardados = 0;
    const fecha = new Intl.DateTimeFormat('es-PA', {
      timeZone: 'America/Panama',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    for (const lugar of lugares) {
      if (!lugar.sitio_web) {
        await env.kairos_db.prepare(
          "INSERT INTO Prospectos (nombre, empresa, rubro, sitio_web, correo, fuente, fecha) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(lugar.nombre, lugar.nombre, lugar.categoria || query, '', '', 'foursquare', fecha).run();
        guardados++;
      }
    }

    console.log(`Foursquare: ${lugares.length} encontrados, ${guardados} guardados como prospectos`);

    return Response.json({ success: true, lugares, guardados });

  } catch (error) {
    console.error('Error en lugares:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}