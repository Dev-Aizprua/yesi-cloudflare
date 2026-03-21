export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { para, nombre, empresa, asunto, cuerpo } = await request.json();

    if (!para || !cuerpo) {
      return Response.json({ success: false, error: 'Faltan campos requeridos: para, cuerpo' }, { status: 400 });
    }

    const panamaTime = new Intl.DateTimeFormat('es-PA', {
      timeZone: 'America/Panama',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    // Plantilla HTML profesional
    const htmlBody = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 30px auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .header { background: #145a32; padding: 30px; text-align: center; }
    .header h1 { color: #2ecc71; font-size: 24px; margin: 0; letter-spacing: 2px; }
    .header p { color: #bdc3c7; font-size: 12px; margin: 5px 0 0; }
    .body { padding: 30px; color: #333; line-height: 1.7; }
    .body p { margin: 0 0 15px; }
    .cta { text-align: center; margin: 25px 0; }
    .cta a { background: #2ecc71; color: #fff; padding: 12px 30px; border-radius: 5px; text-decoration: none; font-weight: bold; font-size: 14px; }
    .footer { background: #f9f9f9; padding: 20px; text-align: center; font-size: 11px; color: #999; border-top: 1px solid #eee; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>TECHZONE</h1>
      <p>Soluciones Web para tu Negocio</p>
    </div>
    <div class="body">
      ${cuerpo.replace(/\n/g, '<br>')}
      <div class="cta">
        <a href="mailto:eduardo.aizpruap@gmail.com">Contáctanos Ahora</a>
      </div>
    </div>
    <div class="footer">
      <p>TechZone Panamá · eduardo.aizpruap@gmail.com</p>
      <p>Este correo fue enviado el ${panamaTime}</p>
    </div>
  </div>
</body>
</html>`;

    // Enviar con Resend
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'TechZone Panamá <onboarding@resend.dev>',
        to: [para],
        subject: asunto || `Propuesta para ${empresa || nombre || 'su negocio'}`,
        html: htmlBody,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Error Resend:', JSON.stringify(data));
      return Response.json({ success: false, error: data.message || 'Error enviando correo' }, { status: 500 });
    }

    // Guardar en Interacciones
    await env.kairos_db.prepare(
      "INSERT INTO Interacciones (prospecto_id, tipo, contenido, estado, fecha) VALUES (?, ?, ?, ?, ?)"
    ).bind(0, 'email', `Para: ${para} | Asunto: ${asunto}`, 'enviado', new Intl.DateTimeFormat('es-PA', { timeZone: 'America/Panama', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date())).run();

    return Response.json({ success: true, id: data.id });

  } catch (error) {
    console.error('Error en correo:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}