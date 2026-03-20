import { sheetsGet, sheetsAppend } from './_shared.js';

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const data = await sheetsGet(env, 'Memoria!A2:C');
    const rows = data.values || [];
    const memoria = rows.map(r => ({ categoria: r[0] || '', dato: r[1] || '', fecha: r[2] || '' }));
    return Response.json({ success: true, memoria });
  } catch (error) {
    return Response.json({ success: false, memoria: [] });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { categoria, dato } = await request.json();
    const fecha = new Intl.DateTimeFormat('es-PA', {
      timeZone: 'America/Panama',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    await sheetsAppend(env, 'Memoria!A:C', [[categoria, dato, fecha]]);
    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
