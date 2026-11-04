// functions/lib/adminAuth.js
// Acceso a la consola de administración (Eduardo). Contraseña con PBKDF2-SHA256 (nunca en texto), sesión con cookie
// HttpOnly + SameSite=Strict (guardada con hash), bloqueo temporal tras varios intentos fallidos y mensajes de error
// iguales para "correo no existe" y "clave incorrecta". No hay registro público: los administradores se crean a mano
// con scripts/crear_admin.mjs.

import { generarSecreto, sha256Hex, leerCookie } from './accesoWeb.js';

export const NOMBRE_COOKIE_ADMIN = 'oficina_admin';
export const HORAS_SESION_ADMIN = 8;
export const MAX_INTENTOS = 5;
export const MINUTOS_BLOQUEO = 15;
export const ITERACIONES = 100000; // el máximo que permite Cloudflare Workers para PBKDF2
export const MIN_LARGO_CLAVE = 12;

const aSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const aB64 = (bytes) => { let b = ''; for (const x of bytes) b += String.fromCharCode(x); return btoa(b); };
const deB64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function derivar(clave, sal, iteraciones) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(clave)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: iteraciones }, base, 256));
}

/** Formato guardado: pbkdf2$iteraciones$sal(base64)$hash(base64) */
export async function hashClave(clave, sal = crypto.getRandomValues(new Uint8Array(16)), iteraciones = ITERACIONES) {
  return `pbkdf2$${iteraciones}$${aB64(sal)}$${aB64(await derivar(clave, sal, iteraciones))}`;
}

function iguales(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function verificarClave(clave, guardado) {
  const p = String(guardado ?? '').split('$');
  if (p.length !== 4 || p[0] !== 'pbkdf2') return false;
  const it = Number(p[1]);
  if (!Number.isInteger(it) || it < 1000 || it > 1000000) return false;
  try { return iguales(await derivar(clave, deB64(p[2]), it), deB64(p[3])); } catch { return false; }
}

/** Reglas mínimas de la clave. @returns {string|null} el motivo, o null si sirve */
export function problemaDeClave(clave) {
  const c = String(clave ?? '');
  if (c.length < MIN_LARGO_CLAVE) return `La clave debe tener al menos ${MIN_LARGO_CLAVE} caracteres.`;
  if (c.length > 200) return 'La clave es demasiado larga.';
  if (!/[A-Za-z]/.test(c) || !/\d/.test(c)) return 'La clave debe mezclar letras y números.';
  return null;
}

let HASH_FALSO = null; // para que "correo no existe" tarde lo mismo que "clave incorrecta"

/**
 * Inicia sesión. @returns {{ok:true, sesion:string, nombre:string, correo:string} | {ok:false, motivo:'credenciales'|'bloqueado'}}
 * El motivo 'bloqueado' solo se devuelve si el correo existe y está bloqueado; el navegador debe mostrar el mismo texto genérico.
 */
export async function iniciarSesionAdmin(db, correo, clave, ahora = new Date()) {
  const c = String(correo ?? '').trim().toLowerCase().slice(0, 200);
  const fila = c ? await db.prepare('SELECT * FROM admin_usuarios WHERE correo = ? AND activo = 1').bind(c).first() : null;
  if (!fila) {
    HASH_FALSO ??= await hashClave('relleno-para-igualar-el-tiempo');
    await verificarClave(String(clave ?? ''), HASH_FALSO);
    return { ok: false, motivo: 'credenciales' };
  }
  if (fila.bloqueado_hasta && fila.bloqueado_hasta > aSql(ahora)) return { ok: false, motivo: 'bloqueado' };
  if (!(await verificarClave(String(clave ?? ''), fila.clave_hash))) {
    const intentos = fila.intentos_fallidos + 1;
    if (intentos >= MAX_INTENTOS) {
      await db.prepare('UPDATE admin_usuarios SET intentos_fallidos = 0, bloqueado_hasta = ? WHERE id = ?')
        .bind(aSql(new Date(ahora.getTime() + MINUTOS_BLOQUEO * 60000)), fila.id).run();
    } else {
      await db.prepare('UPDATE admin_usuarios SET intentos_fallidos = ? WHERE id = ?').bind(intentos, fila.id).run();
    }
    return { ok: false, motivo: 'credenciales' };
  }
  const sesion = generarSecreto();
  await db.prepare('UPDATE admin_usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = ?').bind(fila.id).run();
  await db.prepare('DELETE FROM sesiones_admin WHERE expira_en <= ?').bind(aSql(ahora)).run();
  await db.prepare('INSERT INTO sesiones_admin (admin_id, sesion_hash, expira_en) VALUES (?, ?, ?)')
    .bind(fila.id, await sha256Hex(sesion), aSql(new Date(ahora.getTime() + HORAS_SESION_ADMIN * 3600 * 1000))).run();
  await db.prepare('INSERT INTO auditoria_admin (admin_id, accion, entidad, entidad_id) VALUES (?, ?, ?, ?)').bind(fila.id, 'inicio_sesion', 'admin', fila.id).run();
  return { ok: true, sesion, nombre: fila.nombre, correo: fila.correo };
}

export function cookieAdmin(valor, maxAgeSeg = HORAS_SESION_ADMIN * 3600) {
  return `${NOMBRE_COOKIE_ADMIN}=${valor}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeg}`;
}

/** Administrador de la sesión de esta petición, o null. */
export async function sesionAdminDeRequest(db, request, ahora = new Date()) {
  const valor = leerCookie(request, NOMBRE_COOKIE_ADMIN);
  if (!valor || !/^[A-Za-z0-9_-]{30,64}$/.test(valor)) return null;
  const f = await db.prepare(
    `SELECT a.id, a.nombre, a.correo FROM sesiones_admin s JOIN admin_usuarios a ON a.id = s.admin_id
      WHERE s.sesion_hash = ? AND s.expira_en > ? AND a.activo = 1`
  ).bind(await sha256Hex(valor), aSql(ahora)).first();
  return f ? { adminId: f.id, nombre: f.nombre, correo: f.correo } : null;
}

export async function cerrarSesionAdmin(db, request) {
  const valor = leerCookie(request, NOMBRE_COOKIE_ADMIN);
  if (!valor || !/^[A-Za-z0-9_-]{30,64}$/.test(valor)) return;
  await db.prepare('DELETE FROM sesiones_admin WHERE sesion_hash = ?').bind(await sha256Hex(valor)).run();
}

/** Peticiones que cambian algo: mismo sitio y JSON (la cookie ya es SameSite=Strict). null = pasa; si no, el estado HTTP. */
export function rechazoDePeticion(request) {
  const origen = request.headers.get('Origin');
  if (origen && origen !== new URL(request.url).origin) return 403;
  if (!/application\/json/i.test(request.headers.get('Content-Type') || '')) return 415;
  return null;
}