// functions/api/consola/login.js
// POST /api/consola/login {correo, clave} → inicia la sesión del administrador (cookie HttpOnly).
import { iniciarSesionAdmin, cookieAdmin, rechazoDePeticion } from '../../lib/adminAuth.js';

const CABECERAS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const responder = (obj, estado = 200, extra = {}) => new Response(JSON.stringify(obj), { status: estado, headers: { ...CABECERAS, ...extra } });
const MENSAJE_GENERICO = 'Correo o clave incorrectos, o el acceso está bloqueado un momento. Intenta de nuevo en unos minutos.';

export async function onRequestPost({ request, env }) {
  const malo = rechazoDePeticion(request);
  if (malo) return responder({ ok: false, error: 'Petición no válida.' }, malo);
  let cuerpo = null;
  try { cuerpo = await request.json(); } catch { return responder({ ok: false, error: 'Petición no válida.' }, 400); }
  if (typeof cuerpo?.correo !== 'string' || typeof cuerpo?.clave !== 'string' || cuerpo.clave.length > 200) {
    return responder({ ok: false, error: 'Petición no válida.' }, 400);
  }
  let r = null;
  try { r = await iniciarSesionAdmin(env.oficina_ia_db, cuerpo.correo, cuerpo.clave); } catch (e) { console.log('[CONSOLA] login:', e?.message); }
  if (!r || !r.ok) return responder({ ok: false, error: MENSAJE_GENERICO }, 401);
  return responder({ ok: true, nombre: r.nombre }, 200, { 'Set-Cookie': cookieAdmin(r.sesion) });
}