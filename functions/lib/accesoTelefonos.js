// functions/lib/accesoTelefonos.js
// Separación por teléfono en un número de WhatsApp COMPARTIDO.
// El número del bot ("canal") lo usan varios negocios; cada negocio tiene sus teléfonos autorizados en
// la tabla telefonos_autorizados. Un teléfono que no está autorizado NO toca ningún dato y no gasta Groq:
// se anota en contactos_desconocidos y recibe un aviso fijo (máximo uno cada 24 horas).
// Falla cerrado: si no se puede verificar quién escribe, no se atiende.

/** Teléfono (solo dígitos) o identificador de usuario de WhatsApp (BSUID, ej. "PA.2487…") en forma comparable. */
export function normalizarIdentificador(valor) {
  const t = String(valor ?? '').trim();
  if (!t) return '';
  if (/[a-z]/i.test(t)) return t.toUpperCase();   // BSUID: se compara tal cual (sin distinguir mayúsculas)
  return t.replace(/\D/g, '');                    // teléfono: solo dígitos
}

/** Todos los identificadores con los que Meta puede presentar a quien escribe, sin repetir. */
export function identificadoresDelRemitente(value, mensaje) {
  const crudos = [
    mensaje?.from, mensaje?.from_user_id,
    value?.contacts?.[0]?.wa_id, value?.contacts?.[0]?.user_id,
  ];
  const vistos = new Set();
  const salida = [];
  for (const c of crudos) {
    const n = normalizarIdentificador(c);
    if (n && !vistos.has(n)) { vistos.add(n); salida.push(n); }
  }
  return salida;
}

export const TEXTO_NO_ACTIVADO =
  'Hola 👋 Este número todavía no está activado para usar el asistente. ' +
  'Si ya tienes tu suscripción, pide tu activación a TechZone y te avisamos cuando esté listo.';

/** ¿Pasaron 24 horas desde el último aviso a este contacto desconocido? */
export function debeAvisar(ultimoAviso, ahora = new Date()) {
  if (!ultimoAviso) return true;
  const t = Date.parse(String(ultimoAviso).replace(' ', 'T') + (String(ultimoAviso).includes('Z') ? '' : 'Z'));
  if (!Number.isFinite(t)) return true;
  return ahora.getTime() - t >= 24 * 60 * 60 * 1000;
}

/** Negocio activo al que pertenece quien escribe por este canal (o null). */
export async function buscarNegocioDelRemitente(db, canalPhoneNumberId, identificadores) {
  if (!canalPhoneNumberId || !identificadores?.length) return null;
  const marcas = identificadores.map(() => '?').join(',');
  return await db.prepare(
    `SELECT n.* FROM telefonos_autorizados t
       JOIN negocios n ON n.id = t.negocio_id
      WHERE t.canal_phone_number_id = ? AND t.activo = 1 AND n.activo = 1
        AND t.identificador IN (${marcas})
      ORDER BY t.id LIMIT 1`
  ).bind(canalPhoneNumberId, ...identificadores).first();
}

/**
 * Quien no está autorizado: se anota (para saber quién escribe) y se le avisa como máximo cada 24 h.
 * No guarda conversación, no descarga audios ni fotos, no llama a Groq.
 * @returns {Promise<{avisado:boolean}>}
 */
export async function atenderRemitenteDesconocido(db, canal, value, mensaje, identificadores, enviar, ahora = new Date()) {
  const clave = identificadores[0] || 'desconocido';
  const nombre = String(value?.contacts?.[0]?.profile?.name ?? '').slice(0, 80) || null;
  const texto = mensaje?.type === 'text' ? String(mensaje?.text?.body ?? '').slice(0, 200) : `[${mensaje?.type ?? 'mensaje'}]`;
  const canalId = canal.phone_number_id;
  const ahoraIso = ahora.toISOString().slice(0, 19).replace('T', ' ');
  let previo = null;
  try {
    previo = await db.prepare(
      'SELECT id, ultimo_aviso FROM contactos_desconocidos WHERE canal_phone_number_id = ? AND identificador = ?'
    ).bind(canalId, clave).first();
    if (previo) {
      await db.prepare(
        'UPDATE contactos_desconocidos SET veces = veces + 1, ultima_vez = ?, ultimo_texto = ?, nombre_perfil = COALESCE(?, nombre_perfil) WHERE id = ?'
      ).bind(ahoraIso, texto, nombre, previo.id).run();
    } else {
      await db.prepare(
        'INSERT INTO contactos_desconocidos (canal_phone_number_id, identificador, nombre_perfil, primer_texto, ultimo_texto, veces, primera_vez, ultima_vez) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
      ).bind(canalId, clave, nombre, texto, texto, ahoraIso, ahoraIso).run();
    }
  } catch (e) {
    console.log('[ACCESO] No se pudo anotar al contacto desconocido:', e.message);
  }
  if (previo && !debeAvisar(previo.ultimo_aviso, ahora)) return { avisado: false };
  try {
    await enviar(canal.wa_token, canal.phone_number_id, mensaje.from || mensaje.from_user_id, TEXTO_NO_ACTIVADO);
    await db.prepare(
      'UPDATE contactos_desconocidos SET ultimo_aviso = ? WHERE canal_phone_number_id = ? AND identificador = ?'
    ).bind(ahoraIso, canalId, clave).run();
    return { avisado: true };
  } catch (e) {
    console.log('[ACCESO] No se pudo enviar el aviso de número no activado:', e.message);
    return { avisado: false };
  }
}