// functions/lib/accesoWeb.js
// Acceso a la oficina web: el dueño escribe "mi oficina" por WhatsApp y recibe un enlace de UN SOLO USO
// (vence en 10 minutos). Al canjearlo se crea una sesión (cookie HttpOnly). Todo se guarda con hash:
// ni el enlace ni la sesión quedan legibles en la base. Solo el rol "dueno" puede pedir el enlace.

export const MINUTOS_ENLACE = 10;
export const HORAS_SESION = 8;
export const NOMBRE_COOKIE = 'oficina_sesion';

const aSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

/** ¿El mensaje pide abrir la oficina web? Solo frases cortas y claras (no roba pedidos de otras funciones). */
export function detectarPedidoOficina(texto) {
  const s = String(texto ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[¿?¡!.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 60) return false;
  return /^(abre |abrir |abreme |entrar a |entrar en |quiero entrar a |quiero ver |ver |dame |mandame |enviame |pasame |necesito )?(el )?(mi )?(oficina web|oficina|enlace de (mi )?oficina|link de (mi )?oficina|pagina web|mi pagina)( por favor| porfa)?$/.test(s)
    && /oficina|pagina/.test(s);
}

function aBase64Url(bytes) {
  let b = '';
  for (const x of bytes) b += String.fromCharCode(x);
  return btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generarSecreto() {
  return aBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(texto) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(texto)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** ¿Este remitente es DUEÑO activo del negocio en este canal? */
export async function esDuenoDelNegocio(db, negocioId, canalPhoneNumberId, identificadores) {
  if (!negocioId || !canalPhoneNumberId || !identificadores?.length) return false;
  const marcas = identificadores.map(() => '?').join(',');
  const fila = await db.prepare(
    `SELECT id FROM telefonos_autorizados
      WHERE negocio_id = ? AND canal_phone_number_id = ? AND activo = 1 AND rol = 'dueno'
        AND identificador IN (${marcas}) LIMIT 1`
  ).bind(negocioId, canalPhoneNumberId, ...identificadores).first();
  return !!fila;
}

/** Crea un enlace nuevo (los anteriores sin usar de ese negocio dejan de servir) y devuelve la URL completa. */
export async function crearEnlaceAcceso(db, negocioId, origen, ahora = new Date()) {
  const secreto = generarSecreto();
  const hash = await sha256Hex(secreto);
  const vence = new Date(ahora.getTime() + MINUTOS_ENLACE * 60 * 1000);
  await db.prepare('DELETE FROM accesos_web WHERE negocio_id = ?').bind(negocioId).run();
  await db.prepare('INSERT INTO accesos_web (negocio_id, codigo_hash, expira_en) VALUES (?, ?, ?)')
    .bind(negocioId, hash, aSql(vence)).run();
  return `${String(origen).replace(/\/+$/, '')}/api/web/entrar?c=${secreto}`;
}

/** Canjea el enlace (una sola vez) y crea la sesión. @returns {{sesion:string, negocioId:number}|null} */
export async function canjearEnlace(db, secreto, ahora = new Date()) {
  const s = String(secreto ?? '');
  if (!/^[A-Za-z0-9_-]{30,64}$/.test(s)) return null;
  const hash = await sha256Hex(s);
  const usado = await db.prepare(
    'UPDATE accesos_web SET usado_en = ? WHERE codigo_hash = ? AND usado_en IS NULL AND expira_en > ? RETURNING negocio_id'
  ).bind(aSql(ahora), hash, aSql(ahora)).first();
  if (!usado) return null;
  const sesion = generarSecreto();
  const vence = new Date(ahora.getTime() + HORAS_SESION * 3600 * 1000);
  await db.prepare('DELETE FROM sesiones_web WHERE expira_en <= ?').bind(aSql(ahora)).run();
  await db.prepare('INSERT INTO sesiones_web (negocio_id, sesion_hash, expira_en) VALUES (?, ?, ?)')
    .bind(usado.negocio_id, await sha256Hex(sesion), aSql(vence)).run();
  return { sesion, negocioId: usado.negocio_id };
}

export function leerCookie(request, nombre = NOMBRE_COOKIE) {
  const c = request.headers.get('Cookie') || '';
  for (const parte of c.split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) return parte.slice(i + 1).trim();
  }
  return null;
}

export function cookieSesion(valor, maxAgeSeg = HORAS_SESION * 3600) {
  return `${NOMBRE_COOKIE}=${valor}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeg}`;
}

/** Negocio de la sesión de esta petición, o null. El negocio NUNCA se toma de lo que mande el navegador. */
export async function sesionDeRequest(db, request, ahora = new Date()) {
  const valor = leerCookie(request);
  if (!valor || !/^[A-Za-z0-9_-]{30,64}$/.test(valor)) return null;
  const fila = await db.prepare(
    `SELECT s.negocio_id FROM sesiones_web s JOIN negocios n ON n.id = s.negocio_id
      WHERE s.sesion_hash = ? AND s.expira_en > ? AND n.activo = 1`
  ).bind(await sha256Hex(valor), aSql(ahora)).first();
  return fila ? { negocioId: fila.negocio_id } : null;
}

export const TEXTO_SOLO_DUENO = 'La oficina web la abre solo el dueño del negocio.';
export const TEXTO_OFICINA_NO_LISTA = 'La oficina web todavía no está activa. Te aviso cuando esté lista.';

export function textoEnlaceOficina(url) {
  return `Esta es tu oficina web 👇\n${url}\n\nEl enlace sirve una sola vez y vence en ${MINUTOS_ENLACE} minutos. No lo compartas con nadie.`;
}