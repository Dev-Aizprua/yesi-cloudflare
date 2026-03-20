import { sheetsGet } from './_shared.js';

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const data = await sheetsGet(env, 'Logs!A2:E');
    const rows = data.values || [];
    const memoria = rows
      .filter(r => r[3] === 'bueno' || r[3] === 'malo')
      .slice(-20)
      .map(r => ({ comando: r[1] || '', respuesta: r[2] || '', feedback: r[3] || '' }));
    return Response.json({ success: true, memoria });
  } catch (error) {
    return Response.json({ success: false, memoria: [] });
  }
}
