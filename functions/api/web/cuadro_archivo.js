// functions/api/web/cuadro_archivo.js
// GET /api/web/cuadro_archivo?id=N&formato=xlsx|pdf → descarga el cuadro (los mismos generadores que usa el bot).
import { sesionDeRequest } from '../../lib/accesoWeb.js';
import { cargarCuadro } from '../../lib/cuadrosWeb.js';
import { generarExcelCuadro } from '../../lib/excelCuadro.js';
import { generarPdfCuadro } from '../../lib/pdfCuadro.js';

const JSON_H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (mensaje, estado) => new Response(JSON.stringify({ ok: false, error: mensaje }), { status: estado, headers: JSON_H });

export async function onRequestGet({ request, env }) {
  let sesion = null;
  try { sesion = await sesionDeRequest(env.oficina_ia_db, request); } catch (e) { console.log('[WEB] archivo (sesión):', e.message); }
  if (!sesion) return error('Tu sesión no está activa.', 401);
  const url = new URL(request.url);
  const formato = url.searchParams.get('formato');
  if (formato !== 'xlsx' && formato !== 'pdf') return error('Formato no válido.', 400);
  try {
    const c = await cargarCuadro(env.oficina_ia_db, sesion.negocioId, url.searchParams.get('id'));
    if (!c) return error('Ese cuadro no existe.', 404);
    if (c.estructura.tipo === 'secciones') return error('Este reporte todavía se descarga desde WhatsApp.', 400);
    const archivo = formato === 'xlsx'
      ? generarExcelCuadro(c.nombre, c.columnas, c.filas, c.reglas, c.subtitulo, true, c.extras)
      : await generarPdfCuadro(c.nombre, c.columnas, c.filas, c.reglas, c.subtitulo, true, c.extras);
    const nombre = String(archivo.nombreArchivo || `cuadro.${formato}`).replace(/[^A-Za-z0-9._-]/g, '_');
    return new Response(archivo.bytes, {
      status: 200,
      headers: {
        'Content-Type': archivo.mime,
        'Content-Disposition': `attachment; filename="${nombre}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    console.log('[WEB] archivo (generar):', e.message);
    return error('No pude generar el archivo en este momento. Intenta de nuevo en unos minutos.', 500);
  }
}