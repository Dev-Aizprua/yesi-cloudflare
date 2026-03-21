// Feedback loop — últimas interacciones con feedback bueno/malo
export async function onRequestGet(context) {
  const { env } = context;
  try {
    const result = await env.kairos_db.prepare(
      "SELECT contenido, tipo as feedback FROM Interacciones WHERE tipo IN ('bueno', 'malo') ORDER BY id DESC LIMIT 20"
    ).all();

    const memoria = (result.results || []).map(r => ({
      comando: r.contenido?.split(' | RESP: ')[0]?.replace('CMD: ', '') || '',
      respuesta: r.contenido?.split(' | RESP: ')[1] || '',
      feedback: r.feedback
    }));

    return Response.json({ success: true, memoria });
  } catch (error) {
    return Response.json({ success: false, memoria: [] });
  }
}
