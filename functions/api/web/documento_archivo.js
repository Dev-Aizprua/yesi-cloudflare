// functions/api/web/documento_archivo.js
// GET /api/web/documento_archivo?id=N&formato=pdf|docx → vuelve a generar la carta (PDF por defecto) con lo que se dictó y la fecha en que se creó
// (mismo generador que usa el bot). No se guardan archivos: se arma al momento. SOLO el dueño, SOLO su negocio.
import { sesionDeRequest } from '../../lib/accesoWeb.js';
import { cargarDocumentoParaDescarga } from '../../lib/datosNegocio.js';
import { obtenerPlantilla } from '../../lib/plantillasCartas.js';
import { generarPdfCarta } from '../../lib/pdfCarta.js';
import { generarDocxCarta } from '../../lib/motorCartas.js';
import { camposConFechasEnLetras } from '../../lib/fechasCarta.js';

const JSON_H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (mensaje, estado) => new Response(JSON.stringify({ ok: false, error: mensaje }), { status: estado, headers: JSON_H });

export async function onRequestGet({ request, env }) {
  let sesion = null;
  try { sesion = await sesionDeRequest(env.oficina_ia_db, request); } catch (e) { console.log('[WEB] documento (sesión):', e.message); }
  if (!sesion) return error('Tu sesión no está activa.', 401);
  const formato = new URL(request.url).searchParams.get('formato') || 'pdf';
  if (formato !== 'pdf' && formato !== 'docx') return error('Formato no válido.', 400);
  try {
    const doc = await cargarDocumentoParaDescarga(env.oficina_ia_db, sesion.negocioId, new URL(request.url).searchParams.get('id'));
    if (!doc) return error('Ese documento no existe.', 404);
    const plantilla = await obtenerPlantilla(env, doc.plantillaId);
    if (!plantilla) return error('Ya no tengo la plantilla de esta carta. Pídesela de nuevo a tu asistente por WhatsApp.', 404);
    const config = await env.oficina_ia_db.prepare('SELECT membrete_carta, firma_carta FROM configuracion_negocio WHERE negocio_id = ?').bind(sesion.negocioId).first();
    const generar = formato === 'docx' ? generarDocxCarta : generarPdfCarta;
    const archivo = await generar(plantilla, camposConFechasEnLetras(doc.campos), config, doc.creado);
    const nombre = String(archivo.nombreArchivo || `carta.${formato}`).replace(/[^A-Za-z0-9._-]/g, '_');
    return new Response(archivo.bytes, {
      status: 200,
      headers: { 'Content-Type': archivo.mime, 'Content-Disposition': `attachment; filename="${nombre}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  } catch (e) {
    console.log('[WEB] documento (generar):', e.message);
    return error('No pude generar el documento en este momento. Intenta de nuevo en unos minutos.', 500);
  }
}