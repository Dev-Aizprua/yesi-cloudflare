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

    const lugares = (data.results || []).map((p, index) => ({
      numero: index + 1,
      nombre: p.name || '',
      direccion: p.location?.formatted_address || '',
      telefono: p.tel || '',
      sitio_web: p.website || '',
      categoria: p.categories?.[0]?.name || '',
      tiene_web: !!p.website,
    }));

    console.log(`Foursquare: ${lugares.length} lugares encontrados para "${query}"`);

    return Response.json({ success: true, lugares });

  } catch (error) {
    console.error('Error en lugares:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}