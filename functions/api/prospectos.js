// GET: listar prospectos
export async function onRequestGet(context) {
  const { env } = context;
  try {
    const result = await env.kairos_db.prepare(
      "SELECT * FROM Prospectos ORDER BY score DESC, id DESC"
    ).all();
    return Response.json({ success: true, prospectos: result.results || [] });
  } catch (error) {
    return Response.json({ success: false, prospectos: [] });
  }
}

// POST: agregar prospecto
export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { nombre, empresa, rubro, sitio_web, correo, fuente, scoring, score } = await request.json();

    const fecha = new Intl.DateTimeFormat('es-PA', {
      timeZone: 'America/Panama',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    const result = await env.kairos_db.prepare(
      "INSERT INTO Prospectos (nombre, empresa, rubro, sitio_web, correo, fuente, fecha, scoring, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      nombre || '',
      empresa || '',
      rubro || '',
      sitio_web || '',
      correo || '',
      fuente || 'manual',
      fecha,
      scoring || '',
      score || 0
    ).run();

    return Response.json({ success: true, id: result.meta?.last_row_id });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
// DELETE: eliminar prospecto
export async function onRequestDelete(context) {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) {
      return Response.json({ success: false, error: 'ID requerido' }, { status: 400 });
    }
    await env.kairos_db.prepare(
      "DELETE FROM Prospectos WHERE id = ?"
    ).bind(parseInt(id)).run();
    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
// PATCH: actualizar estado y/o correo
export async function onRequestPatch(context) {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) {
      return Response.json({ success: false, error: 'ID requerido' }, { status: 400 });
    }
    const body = await request.json();
    const campos = [];
    const valores = [];

    if (body.estado !== undefined) { campos.push('estado = ?'); valores.push(body.estado); }
    if (body.correo !== undefined) { campos.push('correo = ?'); valores.push(body.correo); }
    if (body.whatsapp !== undefined) { campos.push('whatsapp = ?'); valores.push(body.whatsapp); }

    if (campos.length === 0) {
      return Response.json({ success: false, error: 'Nada que actualizar' }, { status: 400 });
    }

    valores.push(parseInt(id));
    await env.kairos_db.prepare(
      `UPDATE Prospectos SET ${campos.join(', ')} WHERE id = ?`
    ).bind(...valores).run();

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}