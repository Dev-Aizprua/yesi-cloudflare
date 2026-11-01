// functions/api/web/chat.js
// POST /api/web/chat {texto, ultimo?} → responde CONSULTAS del dueño con el mismo código que el bot de WhatsApp
// (responderConsultaWeb, en lib/chatWeb.js). Sin Groq (0 tokens) y sin escribir nada. El negocio sale de la sesión.
import { sesionDeRequest } from '../../lib/accesoWeb.js';
import { responderConsultaWeb } from '../../lib/chatWeb.js';

const CABECERAS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const responder = (obj, estado = 200) => new Response(JSON.stringify(obj), { status: estado, headers: CABECERAS });
const MAX_TEXTO = 500;

export async function onRequestPost({ request, env }) {
  let sesion = null;
  try { sesion = await sesionDeRequest(env.oficina_ia_db, request); } catch (e) { console.log('[WEB] chat (sesión):', e.message); }
  if (!sesion) return responder({ ok: false }, 401);

  // Defensa extra contra peticiones de otros sitios (la cookie ya es SameSite=Strict)
  const origen = request.headers.get('Origin');
  if (origen && origen !== new URL(request.url).origin) return responder({ ok: false, error: 'Petición no válida.' }, 403);
  if (!/application\/json/i.test(request.headers.get('Content-Type') || '')) return responder({ ok: false, error: 'Petición no válida.' }, 415);

  let cuerpo = null;
  try { cuerpo = await request.json(); } catch { return responder({ ok: false, error: 'Petición no válida.' }, 400); }
  const texto = typeof cuerpo?.texto === 'string' ? cuerpo.texto.trim() : '';
  if (!texto) return responder({ ok: false, error: 'Escribe tu pregunta.' }, 400);
  if (texto.length > MAX_TEXTO) return responder({ ok: false, error: `Tu mensaje es muy largo (máximo ${MAX_TEXTO} caracteres).` }, 400);
  const ultimo = typeof cuerpo?.ultimo === 'string' ? cuerpo.ultimo.slice(0, 4000) : '';
  // Si la respuesta anterior fue una pregunta de una escritura, el navegador devuelve esa pareja {u, a} para continuarla.
  const previo = cuerpo?.previo && typeof cuerpo.previo.u === 'string' && typeof cuerpo.previo.a === 'string' && cuerpo.previo.u.trim() && cuerpo.previo.u.length <= 1500 && cuerpo.previo.a.length <= 1500 ? { u: cuerpo.previo.u, a: cuerpo.previo.a } : null;

  try {
    const fila = await env.oficina_ia_db.prepare('SELECT * FROM negocios WHERE id = ? AND activo = 1').bind(sesion.negocioId).first();
    if (!fila) return responder({ ok: false }, 401);
    const negocio = { ...fila };
    delete negocio.wa_token; delete negocio.token; // las funciones de consulta no necesitan credenciales
    const r = await responderConsultaWeb(env, negocio, texto, ultimo, previo);
    if (r.atajo === 'sin_entender') console.log('[WEB-CHAT] sin entender:', JSON.stringify(texto.slice(0, 200)));
    return responder({ ok: true, texto: r.texto, atajo: r.atajo, ir: r.ir || null, archivos: r.archivos || [], confirmar: !!r.confirmar, cancelar: !!r.cancelar, elegir: !!r.elegir, actualizar: !!r.actualizar });
  } catch (e) {
    console.log('[WEB] chat (respuesta):', e?.message);
    return responder({ ok: false, error: 'No pude responder en este momento. Intenta de nuevo en unos segundos.' }, 500);
  }
}