// GET: listar prospectos
export async function onRequestGet(context) {
  const { env } = context;
  try {
    const result = await env.kairos_db.prepare(
      "SELECT * FROM Prospectos ORDER BY score DESC, id DESC"
    ).all();
    return Response.json({ success: true, prospectos: result.results || [] });
  } catch (error) {
    return Response.json({ success: false, prospectos: [] });
  }
}

// POST: agregar prospecto
export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { nombre, empresa, rubro, sitio_web, correo, fuente, scoring, score } = await request.json();

    const fecha = new Intl.DateTimeFormat('es-PA', {
      timeZone: 'America/Panama',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    const result = await env.kairos_db.prepare(
      "INSERT INTO Prospectos (nombre, empresa, rubro, sitio_web, correo, fuente, fecha, scoring, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      nombre || '',
      empresa || '',
      rubro || '',
      sitio_web || '',
      correo || '',
      fuente || 'manual',
      fecha,
      scoring || '',
      score || 0
    ).run();

    return Response.json({ success: true, id: result.meta?.last_row_id });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}