// Delay aleatorio entre 5 y 10 segundos (Anti-Spam Throttling)
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function delayAleatorio() {
  const ms = Math.floor(Math.random() * 5000) + 5000; // 5000-10000ms
  return delay(ms);
}

function generarHtml(cuerpo, panamaTime) {
  return `<!DOCTYPE html>
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
        <a href="mailto:eduardo.aizpruap@gmail.com">Contactanos Ahora</a>
      </div>
    </div>
    <div class="footer">
      <p>TechZone Panama · eduardo.aizpruap@gmail.com</p>
      <p>Este correo fue enviado el ${panamaTime}</p>
    </div>
  </div>
</body>
</html>`;
}

async function enviarUno(env, para, nombre, empresa, asunto, cuerpo, panamaTime) {
  const htmlBody = generarHtml(cuerpo, panamaTime);

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Kairós <kairos@agente.techzone-pro.com>',
      to: [para],
      subject: asunto || `Propuesta para ${empresa || nombre || 'su negocio'}`,
      html: htmlBody,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(`Error enviando a ${para}:`, JSON.stringify(data));
    return { success: false, para, error: data.message || 'Error enviando correo' };
  }

  // Guardar en Interacciones
  try {
    await env.kairos_db.prepare(
      "INSERT INTO Interacciones (prospecto_id, tipo, contenido, estado, fecha) VALUES (?, ?, ?, ?, ?)"
    ).bind(0, 'email', `Para: ${para} | Asunto: ${asunto}`, 'enviado',
      new Intl.DateTimeFormat('es-PA', {
        timeZone: 'America/Panama',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      }).format(new Date())
    ).run();
  } catch(e) {
    console.log('Error guardando interaccion:', e.message);
  }

  console.log(`Correo enviado a ${para}`);
  return { success: true, para, id: data.id };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    const panamaTime = new Intl.DateTimeFormat('es-PA', {
      timeZone: 'America/Panama',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    // ─── MODO LOTE: { lote: [{para, nombre, empresa, rubro}, ...], plantilla: "texto con {nombre} y {rubro}" }
    if (body.lote && Array.isArray(body.lote)) {
      const { lote, plantilla_asunto, plantilla_cuerpo } = body;

      if (!plantilla_cuerpo) {
        return Response.json({ success: false, error: 'Falta plantilla_cuerpo para envio en lote' }, { status: 400 });
      }

      const resultados = [];
      let enviados = 0;
      let fallidos = 0;

      console.log(`Iniciando envio en lote: ${lote.length} correos con throttling 5-10s`);

      for (let i = 0; i < lote.length; i++) {
        const dest = lote[i];

        if (!dest.para) {
          resultados.push({ success: false, para: 'sin correo', error: 'Sin correo' });
          fallidos++;
          continue;
        }

        // Personalizar cuerpo con nombre y rubro
        const cuerpoPersonalizado = plantilla_cuerpo
          .replace(/\{nombre\}/g, dest.nombre || dest.empresa || 'estimado cliente')
          .replace(/\{rubro\}/g, dest.rubro || 'su negocio')
          .replace(/\{empresa\}/g, dest.empresa || dest.nombre || 'su empresa');

        const asuntoPersonalizado = (plantilla_asunto || 'Propuesta de Tienda Web para {nombre}')
          .replace(/\{nombre\}/g, dest.nombre || dest.empresa || 'su negocio')
          .replace(/\{rubro\}/g, dest.rubro || 'su negocio');

        const resultado = await enviarUno(
          env, dest.para, dest.nombre, dest.empresa,
          asuntoPersonalizado, cuerpoPersonalizado, panamaTime
        );

        resultados.push(resultado);
        if (resultado.success) enviados++; else fallidos++;

        // Anti-Spam Throttling: delay 2-3s entre correos (dentro del límite de 30s de CF Workers)
        if (i < lote.length - 1) {
          const espera = Math.floor(Math.random() * 1000) + 2000;
          console.log(`Throttling: esperando ${espera}ms antes del siguiente correo...`);
          await delay(espera);
        }
      }

      // Notificar Telegram con resumen
      try {
        await fetch(`${new URL(request.url).origin}/api/telegram`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mensaje: `📧 <b>Envio en lote completado</b>\n\nEnviados: ${enviados}\nFallidos: ${fallidos}\nTotal: ${lote.length}`
          })
        });
      } catch(e) { /* silencioso */ }

      return Response.json({
        success: true,
        modo: 'lote',
        enviados,
        fallidos,
        total: lote.length,
        resultados
      });
    }

    // ─── MODO INDIVIDUAL: { para, nombre, empresa, asunto, cuerpo }
    const { para, nombre, empresa, asunto, cuerpo } = body;

    if (!para || !cuerpo) {
      return Response.json({ success: false, error: 'Faltan campos requeridos: para, cuerpo' }, { status: 400 });
    }

    const resultado = await enviarUno(env, para, nombre, empresa, asunto, cuerpo, panamaTime);

    if (!resultado.success) {
      return Response.json({ success: false, error: resultado.error }, { status: 500 });
    }

    return Response.json({ success: true, id: resultado.id });

  } catch (error) {
    console.error('Error en correo:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}