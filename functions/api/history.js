import { sheetsGet, sheetsAppend } from './_shared.js';

function resumir(texto) {
  if (!texto || texto.length <= 200) return texto;
  const limpio = texto.replace(/\*\*/g, '').replace(/\*/g, '')
    .replace(/#{1,6} /g, '').replace(/\n+/g, ' ').trim();
  return limpio.substring(0, 197) + '...';
}

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const anclaRes = await sheetsGet(env, 'Historial!C2');
    const ancla = anclaRes.values?.[0]?.[0] || '';

    const totalRes = await sheetsGet(env, 'Historial!A:A');
    const totalFilas = (totalRes.values || []).length;

    const ventana = [];
    if (totalFilas > 2) {
      const inicioFila = Math.max(3, totalFilas - 19);
      const histRes = await sheetsGet(env, `Historial!A${inicioFila}:D${totalFilas}`);
      (histRes.values || []).forEach(r => {
        ventana.push({ timestamp: r[0]||'', role: r[1]||'', content: r[2]||'', session: r[3]||'' });
      });
    }
    return Response.json({ success: true, ancla, historial: ventana });
  } catch (error) {
    return Response.json({ success: false, ancla: '', historial: [] });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { role, content, session } = await request.json();
    const panamaTime = new Intl.DateTimeFormat('es-PA', {
      timeZone: 'America/Panama',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date());
    const contenidoFinal = role === 'agent' ? resumir(content) : content.substring(0, 300);
    await sheetsAppend(env, 'Historial!A:D', [[panamaTime, role, contenidoFinal, session]]);
    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
