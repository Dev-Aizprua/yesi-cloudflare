import { sheetsAppend } from './_shared.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { comando, respuesta, feedback, estado } = await request.json();
    const panamaTime = new Intl.DateTimeFormat('es-PA', {
      timeZone: 'America/Panama',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date());

    await sheetsAppend(env, 'Logs!A:E',
      [[panamaTime, comando, respuesta, feedback || 'pendiente', estado || 'ok']]);

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
