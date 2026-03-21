// Resumir texto a máximo 200 caracteres
function resumir(texto) {
  if (!texto || texto.length <= 200) return texto;
  const limpio = texto.replace(/\*\*/g, '').replace(/\*/g, '')
    .replace(/#{1,6} /g, '').replace(/\n+/g, ' ').trim();
  return limpio.substring(0, 197) + '...';
}

// GET: Ancla Vital + últimas 20 conversaciones
export async function onRequestGet(context) {
  const { env } = context;
  try {
    const db = env.kairos_db;

    // Ancla Vital desde Memoria_Permanente
    const anclaRow = await db.prepare(
      "SELECT dato FROM Memoria_Permanente WHERE categoria = 'ANCLA_VITAL' LIMIT 1"
    ).first();
    const ancla = anclaRow?.dato || '';

    // Últimas 20 conversaciones
    const result = await db.prepare(
      "SELECT role, contenido as content, sesion as session, fecha as timestamp FROM Conversaciones ORDER BY id DESC LIMIT 20"
    ).all();

    const historial = (result.results || []).reverse();

    return Response.json({ success: true, ancla, historial });
  } catch (error) {
    console.error('Error cargando historial:', error.message);
    return Response.json({ success: false, ancla: '', historial: [] });
  }
}

// POST: guardar mensaje
export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { role, content, session } = await request.json();
    const db = env.kairos_db;

    const panamaTime = new Intl.DateTimeFormat('es-PA', {
      timeZone: 'America/Panama',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date());

    const contenidoFinal = role === 'agent' ? resumir(content) : content.substring(0, 300);

    await db.prepare(
      "INSERT INTO Conversaciones (role, contenido, sesion, fecha) VALUES (?, ?, ?, ?)"
    ).bind(role, contenidoFinal, session || '', panamaTime).run();

    return Response.json({ success: true });
  } catch (error) {
    console.error('Error guardando historial:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
