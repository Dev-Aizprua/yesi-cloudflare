// functions/c/[codigo].js
// Redirector de enlaces cortos — así los enlaces de cobro (wa.me con
// el mensaje codificado en la URL) no salen kilométricos por WhatsApp.
//
// Ruta: https://yesi-agente-ia.pages.dev/c/<codigo> -> redirige 302
// al enlace real guardado en D1 (tabla enlaces_cortos).
//
// [codigo].js con corchetes es la sintaxis de Cloudflare Pages
// Functions para una ruta dinámica: /c/abc123 -> context.params.codigo = "abc123"

export async function onRequestGet(context) {
  const { env, params } = context;
  const codigo = params.codigo;

  const fila = await env.oficina_ia_db.prepare(
    'SELECT url_destino FROM enlaces_cortos WHERE codigo = ?'
  ).bind(codigo).first();

  if (!fila) {
    return new Response('Este enlace no existe o ya no está disponible.', { status: 404 });
  }

  return Response.redirect(fila.url_destino, 302);
}