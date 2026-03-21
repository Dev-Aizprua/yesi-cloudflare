// GET: leer memoria permanente
export async function onRequestGet(context) {
  const { env } = context;
  try {
    const result = await env.kairos_db.prepare(
      "SELECT categoria, dato, fecha FROM Memoria_Permanente WHERE categoria != 'ANCLA_VITAL' ORDER BY id DESC"
    ).all();

    const memoria = (result.results || []).map(r => ({
      categoria: r.categoria,
      dato: r.dato,
      fecha: r.fecha
    }));

    return Response.json({ success: true, memoria });
  } catch (error) {
    console.error('Error leyendo memoria:', error.message);
    return Response.json({ success: false, memoria: [] });
  }
}

// POST: guardar dato en memoria permanente
export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { categoria, dato } = await request.json();

    const fecha = new Intl.DateTimeFormat('es-PA', {
      timeZone: 'America/Panama',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    await env.kairos_db.prepare(
      "INSERT INTO Memoria_Permanente (categoria, dato, fecha) VALUES (?, ?, ?)"
    ).bind(categoria, dato, fecha).run();

    return Response.json({ success: true });
  } catch (error) {
    console.error('Error guardando memoria:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
