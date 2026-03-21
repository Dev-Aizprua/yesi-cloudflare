export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { comando, respuesta, feedback, estado } = await request.json();

    const panamaTime = new Intl.DateTimeFormat('es-PA', {
      timeZone: 'America/Panama',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date());

    // Guardar en Interacciones como log general
    await env.kairos_db.prepare(
      "INSERT INTO Interacciones (prospecto_id, tipo, contenido, estado, fecha) VALUES (?, ?, ?, ?, ?)"
    ).bind(0, feedback || 'pendiente', `CMD: ${comando} | RESP: ${respuesta?.substring(0, 200)}`, estado || 'ok', panamaTime).run();

    return Response.json({ success: true });
  } catch (error) {
    console.error('Error guardando log:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
