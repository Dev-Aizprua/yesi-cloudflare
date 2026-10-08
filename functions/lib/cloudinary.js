// ============================================================
// functions/lib/cloudinary.js
// Sube el PNG del cuadro (generado con Satori/resvg) a Cloudinary
// y devuelve la URL pública para mandarla por WhatsApp.
//
// Mismo patrón que ya usa Producto C (panel/cloudinary.js):
// preset "unsigned" — no requiere CLOUDINARY_API_KEY ni SECRET,
// solo separa por carpeta ("folder") para que las imágenes de
// cada negocio no se mezclen entre sí.
//
// Cuenta reutilizada de Producto C (mismo cloud, misma que ya
// tiene el preset "tienda" configurado). Carpeta separada:
// oficina-ia/{slug}  — así nunca se mezcla con producto-c/{slug}.
// ============================================================

const CLOUD_NAME = 'doaqu6s6c';
const PRESET     = 'tienda';

/**
 * Sube bytes de una imagen PNG a Cloudinary (sin credenciales,
 * preset unsigned) y devuelve la URL pública (secure_url).
 *
 * @param {Uint8Array|ArrayBuffer} pngBytes - PNG ya generado (Satori+resvg)
 * @param {object} env - contexto de Cloudflare (no se usa hoy, se deja
 *                        por si en el futuro hace falta leer alguna var)
 * @param {string} [carpeta] - subcarpeta dentro de oficina-ia/, por
 *                              defecto 'general' si no se pasa slug
 * @returns {Promise<string>} URL pública de la imagen subida
 */
export async function subirImagenCloudinary(pngBytes, env, carpeta = 'general') {
  const blob = new Blob([pngBytes], { type: 'image/png' });

  const form = new FormData();
  form.append('file', blob, 'cuadro.png');
  form.append('upload_preset', PRESET);
  form.append('folder', `oficina-ia/${carpeta}`);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
    { method: 'POST', body: form }
  );

  if (!res.ok) {
    const errTexto = await res.text();
    throw new Error(`Cloudinary respondió ${res.status}: ${errTexto}`);
  }

  const data = await res.json();
  return data.secure_url;
}