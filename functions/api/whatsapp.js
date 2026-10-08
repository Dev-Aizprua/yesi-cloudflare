// functions/api/whatsapp.js
// OFICINA IA — Webhook de WhatsApp
// Adaptado para el proyecto Techzone/Kairós (yesi-agente-ia), que usa
// una estructura de carpetas PLANA (functions/api/whatsapp.js), a
// diferencia del proyecto original de Oficina IA
// (functions/api/whatsapp/webhook.js). Por eso los imports de abajo
// usan '../lib/' (un nivel) en vez de '../../lib/' (dos niveles).
//
// Reemplaza por completo la lógica de Kairós que atendía este número
// — el archivo original queda respaldado como whatsapp.kairos.backup.js

import { herramientas } from '../lib/herramientas.js';
import { calcularFila, validarFormula } from '../lib/calculo.js';
import { buscarFila } from '../lib/buscarFila.js';
import { generarImagenCuadro } from '../lib/imagenCuadro.js';
import { generarExcelCuadro } from '../lib/excelCuadro.js';
import { generarPdfCuadro } from '../lib/pdfCuadro.js';
import { subirImagenCloudinary } from '../lib/cloudinary.js';
import { descargarImagenWhatsApp, analizarFotoCuadro } from '../lib/visionCuadro.js';
import { detectarFormulas, validarContraTotales } from '../lib/detectorFormulas.js';
import { listarPlantillasParaPrompt, obtenerPlantilla } from '../lib/plantillasCartas.js';
import { camposFaltantes, generarDocxCarta, capitalizarInicio } from '../lib/motorCartas.js';
import { validarReporteSecciones } from '../lib/reporteSecciones.js';
import { generarImagenReporteSecciones } from '../lib/imagenReporteSecciones.js';
import { generarExcelReporteSecciones } from '../lib/excelReporteSecciones.js';
import { validarPie, validarEncabezado, avisosEncabezado, recalcularPie } from '../lib/tablaExtendida.js';
import { construirDatosCotizacion, siguienteNumeroDocumento, nombreDocumento, elegirCotizacion, buscarDocumentoGuardado, lineasDesdeCuadro, aplicarCorreccionDocumento, describirParaCorreccion, clasificarRespuestaPendiente, filaIndiceDocumento } from '../lib/cotizacion.js';
import { parsearMonto, interpretarFechaPago, fechaIsoPanama, normalizarNumeroDocumento, mismoCliente, calcularSaldos, repartirPago, ordenarMasAntiguoPrimero, textoVistaPrevia, textoElegirDocumento, clasificarRespuestaConfirmacion, clasificarRespuestaElegir, formatoMonto, fechaLegible,
  filtrarPagos, textoElegirPago, clasificarRespuestaElegirIndice, planAnularPago, textoPrevioAnularPago, planAnularDocumento, textoPrevioAnularDocumento, planAplicarSaldo, textoPrevioAplicarSaldo,
  corregirLlamadaPago, esSiNoPuro, columnaDePago, acumularAbono, esCorreccionDeAbono,
  detectarConsultaDeudas, extraerPrestamosDeCuadros, agruparSaldosAFavor, armarReporteDeudas, unirCuadrosDePrestamo,
  normalizarTelefonoPanama, mensajeTelefonoInvalido, cuadroContieneTodos,
  esCampoDeAbono, esCuadroDePrestamo, tieneColumnaAbono, resolverClaveAbono, buscarPersonaEnPrestamos,
  textoRechazoCorreccionAbono, mencionaCuadro, textoVariosExactos, textoParecidos, textoNingunoEnPrestamos, textoConfirmarAbonoParecido } from '../lib/pagos.js';
import { llamarGroqConReintento } from '../lib/groqReintento.js';

// Todas las llamadas a Groq pasan por aquí: si Groq responde 429 (límite por minuto) se espera
// lo que él indica y se reintenta UNA vez, en vez de perder el mensaje del usuario.
const fetchGroq = (url, init) => llamarGroqConReintento(fetch, url, init);

// ── VERIFICACIÓN DEL WEBHOOK (GET) — la pide Meta al configurar ──
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const mode      = url.searchParams.get('hub.mode');
  const token     = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Verificación fallida', { status: 403 });
}

// ── RECEPCIÓN DE MENSAJES (POST) ──────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    console.log('[WEBHOOK] Body completo recibido:', JSON.stringify(body));

    // Estructura real de Meta: entry[].changes[].value.{metadata,messages,contacts}
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const mensajeEntrante = value?.messages?.[0];

    // Si no hay mensaje (ej. es un evento de "leído" o "entregado"), ignorar sin error
    if (!mensajeEntrante) {
      return Response.json({ ok: true, info: 'sin mensaje que procesar' });
    }

    const phoneNumberId = value?.metadata?.phone_number_id;
    // "from" puede venir omitido si la persona activó un nombre de usuario
    // de WhatsApp; en ese caso solo llega su BSUID en "from_user_id".
    const numeroCliente = mensajeEntrante.from || mensajeEntrante.from_user_id;

    // ── 1. Identificar el negocio por phone_number_id ────────────
    const negocio = await env.oficina_ia_db.prepare(
      'SELECT * FROM negocios WHERE phone_number_id = ? AND activo = 1 LIMIT 1'
    ).bind(phoneNumberId).first();
    console.log('[WEBHOOK] Resultado de buscar negocio:', JSON.stringify({ id: negocio?.id, slug: negocio?.slug, activo: negocio?.activo, tipo_bot: negocio?.tipo_bot }));

    if (!negocio) {
      // Número no reconocido o negocio inactivo (suscripción vencida, etc.)
      console.log(`[WEBHOOK] phone_number_id sin negocio activo: ${phoneNumberId}`);
      return Response.json({ ok: true, info: 'negocio no encontrado o inactivo' });
    }

    // ── 2. Confirmación pendiente de borrado de cuadro ────────────
    // Esto NUNCA pasa por Groq — el backend decide con certeza si el
    // mensaje es "CONFIRMAR" o no, sin depender de que el modelo
    // interprete bien la intención de algo tan irreversible.
    if (negocio.confirmacion_pendiente && mensajeEntrante.type === 'text') {
      const pendiente = JSON.parse(negocio.confirmacion_pendiente);
      const respuestaUsuario = mensajeEntrante.text.body.trim().toUpperCase();

      // Limpiar el pendiente siempre, sin importar qué respondió —
      // una confirmación solo vale para el mensaje inmediatamente
      // siguiente, no se queda "abierta" indefinidamente.
      await env.oficina_ia_db.prepare(
        'UPDATE negocios SET confirmacion_pendiente = NULL WHERE id = ?'
      ).bind(negocio.id).run();

      // Se acepta la palabra aunque venga con formato de WhatsApp (*CONFIRMAR*) o
      // puntuación; sigue siendo obligatoria la palabra exacta (no vale "sí" ni "confirmar borrado").
      if (respuestaUsuario.replace(/[\s*_~.,!¡"'`]/g, '') === 'CONFIRMAR') {
        let textoConfirmado;
        try {
          const r = await eliminarCuadroConIndice(env, negocio.id, pendiente.cuadroId);
          if (r.ok) {
            textoConfirmado = `Listo, eliminé el cuadro "${pendiente.nombreCuadro}" por completo.`;
          } else if (r.motivo === 'pagos') {
            textoConfirmado = `No eliminé "${pendiente.nombreCuadro}" porque ya tiene pagos registrados. En vez de borrarla hay que anularla, así se conservan el documento y sus pagos.`;
          } else {
            textoConfirmado = `No pude confirmar si "${pendiente.nombreCuadro}" tiene pagos registrados, así que no la eliminé. Inténtalo de nuevo en un momento.`;
          }
        } catch (e) {
          console.log('[WEBHOOK] Error eliminando cuadro:', pendiente.nombreCuadro, e.message);
          textoConfirmado = `No pude eliminar "${pendiente.nombreCuadro}". Inténtalo de nuevo en un momento.`;
        }
        await guardarMensaje(env, negocio.id, 'asistente', textoConfirmado, 'texto');
        try {
          await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, textoConfirmado);
        } catch (e) {
          console.log('[WEBHOOK] Error enviando confirmación de borrado:', e.message);
        }
      } else {
        const textoCancelado = `Cancelado — no eliminé el cuadro "${pendiente.nombreCuadro}". Sigue igual.`;
        await guardarMensaje(env, negocio.id, 'asistente', textoCancelado, 'texto');
        try {
          await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, textoCancelado);
        } catch (e) {
          console.log('[WEBHOOK] Error enviando cancelación:', e.message);
        }
      }
      return Response.json({ ok: true, negocio: negocio.slug, confirmacion_procesada: true });
    }

    // ── 3. Si está en modo manual, no responder automático ───────
    // (Eduardo está manejando esta conversación desde Telegram)
    if (negocio.modo === 'manual') {
      await guardarMensaje(env, negocio.id, 'usuario', mensajeEntrante.text?.body || '[mensaje]', 'texto');
      return Response.json({ ok: true, info: 'modo manual — no se autoresponde' });
    }

    // ── 3. Extraer el contenido del mensaje (texto o audio) ──────
    let textoUsuario = '';
    let tipoMensaje = 'texto';

    if (mensajeEntrante.type === 'text') {
      textoUsuario = mensajeEntrante.text.body;
    } else if (mensajeEntrante.type === 'audio') {
      tipoMensaje = 'audio';
      try {
        textoUsuario = await transcribirAudioWA(mensajeEntrante.audio.id, negocio.wa_token, env.GROQ_API_KEY);
      } catch (e) {
        console.log('[WEBHOOK] Error transcribiendo audio:', e.message);
        return Response.json({ ok: true, error: 'no se pudo transcribir el audio' });
      }
    } else if (mensajeEntrante.type === 'image') {
      // Las fotos de un cuadro NO pasan por Groq con herramientas —
      // tienen su propio flujo completo (leer, validar, pedir confirmación).
      return await procesarFotoCuadro(env, negocio, numeroCliente, mensajeEntrante);
    } else {
      // Tipo no soportado todavía (documento, sticker, etc.)
      return Response.json({ ok: true, info: `tipo de mensaje no soportado: ${mensajeEntrante.type}` });
    }

    if (!textoUsuario) {
      return Response.json({ ok: true, info: 'mensaje vacío tras procesar' });
    }

    // ── 3.5. ¿Hay un cuadro importado de una foto esperando confirmación? ──
    // Si es así, este mensaje de texto NO es para las 7 herramientas
    // normales — es la respuesta a "¿está bien así?".
    const importacionPendiente = await env.oficina_ia_db.prepare(
      'SELECT datos FROM importaciones_pendientes WHERE negocio_id = ?'
    ).bind(negocio.id).first();
    if (importacionPendiente) {
      return await procesarRespuestaImportacion(env, negocio, numeroCliente, textoUsuario, importacionPendiente);
    }

    // ── 3.6. ¿Hay una carta a medio dictar, esperando datos que faltan? ──
    // Mismo patrón que importaciones_pendientes: este mensaje NO pasa
    // por las herramientas normales de Groq — es la respuesta a "me
    // falta tal dato", o una cancelación.
    const cartaPendiente = await env.oficina_ia_db.prepare(
      'SELECT plantilla_id, campos_capturados, estado FROM cartas_pendientes WHERE negocio_id = ?'
    ).bind(negocio.id).first();
    if (cartaPendiente) {
      return await procesarRespuestaCartaPendiente(env, negocio, numeroCliente, textoUsuario, cartaPendiente);
    }

    // ── 3.7. "sí"/"no" suelto sin nada pendiente ─────────────────
    // Si el mensaje es EXACTAMENTE sí/no, no hay pendiente (ya pasaron 3.5 y 3.6) y la última fila
    // de la conversación es un mensaje del bot MARCADO como cerrado (lo marca marcarFlujoPagoCerrado
    // al terminar un flujo de pago), se responde fijo y NO se llama a Groq (~7,000 tokens).
    // Un "sí" a una pregunta libre de Groq (mensaje sin marca) sigue pasando a Groq. Si la columna
    // `cerrado` aún no existe (migración sin correr), la consulta falla y se sigue como antes.
    if (esSiNoPuro(textoUsuario)) {
      let ultimaFila = null;
      try {
        ultimaFila = await env.oficina_ia_db.prepare(
          'SELECT rol, cerrado FROM conversaciones WHERE negocio_id = ? ORDER BY id DESC LIMIT 1'
        ).bind(negocio.id).first();
      } catch (e) {
        console.log('[WEBHOOK] Sin columna conversaciones.cerrado (¿falta la migración?):', e.message);
      }
      if (ultimaFila && ultimaFila.rol === 'asistente' && Number(ultimaFila.cerrado) === 1) {
        try {
          await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
            'No tengo nada pendiente por confirmar. Dime qué necesitas y lo hago.');
        } catch (e) {
          console.log('[WEBHOOK] Error enviando aviso de sin pendiente:', e.message);
        }
        return Response.json({ ok: true, negocio: negocio.slug, sin_pendiente: true });
      }
    }

    // ── 3.8. "¿Quién me debe?": consulta de información, se responde en código ──
    // Va DESPUÉS de los pendientes (3.5/3.6) y del "sí/no" suelto (3.7), así un "sí" nunca se confunde
    // con una consulta. No llama a Groq (0 tokens). Si armar el reporte falla, se sigue con el flujo normal.
    const consultaDeudas = detectarConsultaDeudas(textoUsuario);
    if (consultaDeudas) {
      let reporte = null;
      try {
        reporte = await armarReporteDeudasNegocio(env, negocio, consultaDeudas);
      } catch (e) {
        console.log('[WEBHOOK] Error armando el reporte de deudas, se sigue con Groq:', e.message);
      }
      if (reporte) {
        await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, reporte);
        // Se guarda el intercambio para que Groq no vea un historial incompleto, y se marca como cerrado
        // (el reporte es una instrucción, no una pregunta: un "sí" después recibe "nada pendiente").
        await guardarMensaje(env, negocio.id, 'usuario', textoUsuario, tipoMensaje);
        await guardarMensaje(env, negocio.id, 'asistente', reporte, 'texto');
        await marcarFlujoPagoCerrado(env, negocio.id);
        return Response.json({ ok: true, negocio: negocio.slug, consulta: 'deudas' });
      }
    }

    // ── 4. Guardar el mensaje entrante en el historial ────────────
    // Se guarda el id: si Groq falla, este mensaje se borra del historial (si no, el siguiente mensaje
    // haría que Groq intente cumplir también el que falló).
    const idMensajeUsuario = await guardarMensaje(env, negocio.id, 'usuario', textoUsuario, tipoMensaje);

    // ── 5. Cargar contexto mínimo para Groq (no todo, por tokens) ─
    const { results: historialReciente } = await env.oficina_ia_db.prepare(
      'SELECT rol, mensaje FROM conversaciones WHERE negocio_id = ? ORDER BY id DESC LIMIT 6'
    ).bind(negocio.id).all();

    const { results: cuadrosDelNegocio } = await env.oficina_ia_db.prepare(
      'SELECT nombre_cuadro, estructura FROM cuadros WHERE negocio_id = ?'
    ).bind(negocio.id).all();

    const cartasDisponibles = await listarPlantillasParaPrompt(env);

    // ── 6. Armar el system prompt y llamar a Groq con Tool Use ────
    // registrar_pago solo se ofrece a negocios que ya tienen facturas proforma: un negocio de
    // préstamos (como el del financista) nunca la ve, y sus abonos siguen por actualizar_fila.
    const conPagos = await negocioTieneProformas(env, negocio.id);
    const conAjustes = await negocioTieneDocumentos(env, negocio.id);
    const herramientasDisponibles = herramientas.filter(h =>
      (h.function.name !== 'registrar_pago' || conPagos) && (h.function.name !== 'ajustar_pago' || conAjustes));
    const systemPrompt = construirSystemPrompt(negocio, cuadrosDelNegocio, cartasDisponibles, conPagos, conAjustes);

    const mensajesGroq = [
      { role: 'system', content: systemPrompt },
      // El historial viene DESC (más reciente primero) — lo invertimos para orden cronológico
      ...historialReciente.reverse().map(m => ({
        role: m.rol === 'usuario' ? 'user' : 'assistant',
        content: m.mensaje,
      })),
    ];

    console.log('[WEBHOOK] Llamando a Groq con', mensajesGroq.length, 'mensajes...');

    let respuestaGroq;
    let dataGroq;
    try {
      respuestaGroq = await fetchGroq('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: mensajesGroq,
          tools: herramientasDisponibles,
          tool_choice: 'auto',
        }),
      });
      dataGroq = await respuestaGroq.json();
    } catch (e) {
      // Red caída o respuesta que no es JSON: mismo trato que un error de Groq.
      console.log('[WEBHOOK] Falló la llamada a Groq:', e.message);
      await descartarMensajeFallido(env, negocio.id, idMensajeUsuario);
      try {
        await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
          'Tuve un problema al procesar tu mensaje. Inténtalo de nuevo en unos segundos, por favor.');
      } catch (e2) {
        console.log('[WEBHOOK] No pude enviar el aviso de error de Groq:', e2.message);
      }
      return Response.json({ ok: false, error: e.message });
    }
    console.log('[WEBHOOK] Respuesta de Groq (status ' + respuestaGroq.status + '):', JSON.stringify(dataGroq).slice(0, 1500));

    if (dataGroq.error) {
      console.log('[WEBHOOK] Error de Groq:', dataGroq.error.message);
      await descartarMensajeFallido(env, negocio.id, idMensajeUsuario);
      // Antes el usuario se quedaba sin respuesta. Ahora se le avisa (ya se reintentó una vez si era un 429 corto).
      const textoAviso = respuestaGroq.status === 429
        ? 'Estoy con mucho trabajo en este momento 🙏 Repite tu mensaje en unos segundos, por favor.'
        : 'Tuve un problema al procesar tu mensaje. Inténtalo de nuevo en unos segundos, por favor.';
      try {
        await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, textoAviso);
      } catch (e) {
        console.log('[WEBHOOK] No pude enviar el aviso de error de Groq:', e.message);
      }
      return Response.json({ ok: false, error: dataGroq.error.message });
    }

    const mensajeModelo = dataGroq.choices?.[0]?.message;
    const llamada = mensajeModelo?.tool_calls?.[0];

    if (!llamada) {
      // Groq respondió con texto plano en vez de usar una herramienta
      // (ej. un simple "Hola" que no encaja en ninguna acción clara) —
      // igual hay que mandarlo por WhatsApp de verdad, no solo devolverlo en el JSON.
      const textoRespuesta = mensajeModelo?.content || 'Hola, ¿en qué te puedo ayudar?';
      await guardarMensaje(env, negocio.id, 'asistente', textoRespuesta, 'texto');
      try {
        const resMeta = await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, textoRespuesta);
        console.log('[WEBHOOK] Respuesta de Meta (sin herramienta):', JSON.stringify(resMeta));
      } catch (e) {
        console.log('[WEBHOOK] Error enviando por WhatsApp (sin herramienta):', e.message);
      }
      return Response.json({
        ok: true,
        negocio: negocio.slug,
        sin_herramienta: true,
        respuesta_texto: textoRespuesta,
      });
    }

    // ── 7. Aplicar la acción de verdad sobre cuadros/D1 ───────────
    const argumentos = JSON.parse(llamada.function.arguments);
    // Red de seguridad determinista (pagos.js): corrige decisiones de Groq que el texto del usuario desmiente.
    const corregida = corregirLlamadaPago(textoUsuario, llamada.function.name, argumentos);
    if (corregida.corregida) {
      console.log('[WEBHOOK] Llamada corregida por código:', corregida.corregida, JSON.stringify(corregida.args));
    }
    // _mensajeId lo pone SIEMPRE el código (pisa lo que mande Groq): evita sumar dos veces un abono si Meta reenvía el mensaje.
    const resultado = await aplicarAccion(env, negocio, corregida.nombre, { ...corregida.args, _mensajeId: mensajeEntrante.id || null, _texto: textoUsuario });

    await guardarMensaje(env, negocio.id, 'asistente', resultado.mensaje, 'texto');
    // Un abono directo (o su rechazo) no deja nada pendiente: un "sí" suelto después no debe llegar a Groq.
    if (resultado.cerrarFlujo) await marcarFlujoPagoCerrado(env, negocio.id);

    // Cotización armada por texto/voz: se guarda como importación PENDIENTE y
    // se muestra igual que una foto (imagen + texto para sí / no / corregir).
    if (resultado.datosImportacion) {
      await env.oficina_ia_db.prepare(
        `INSERT INTO importaciones_pendientes (negocio_id, datos) VALUES (?, ?)
         ON CONFLICT(negocio_id) DO UPDATE SET datos = excluded.datos, creado_en = datetime('now')`
      ).bind(negocio.id, JSON.stringify(resultado.datosImportacion)).run();
      await enviarVistaPreviaImportacion(env, negocio, numeroCliente, resultado.datosImportacion);
      return Response.json({ ok: true, negocio: negocio.slug, herramienta: llamada.function.name, importacion_pendiente: true });
    }

    // ── 8. Generar la imagen del cuadro, si esta acción la necesita ─
    let pngBytes = null;
    if (resultado.generarImagen && resultado.datosCuadro) {
      try {
        pngBytes = await generarImagenCuadro(
          resultado.datosCuadro.nombreCuadro,
          resultado.datosCuadro.columnas,
          resultado.datosCuadro.filas,
          resultado.datosCuadro.subtitulo,
          true,
          resultado.datosCuadro.extras || {}
        );
      } catch (e) {
        console.log('[WEBHOOK] Error generando imagen:', e.message);
      }
    }
    // Reporte tipo "secciones" (ej. Pago de Quincena) — mismo pngBytes,
    // mismo camino de Cloudinary/envío de abajo, solo cambia el generador.
    if (resultado.generarImagenSecciones && resultado.datosReporteSecciones) {
      try {
        pngBytes = await generarImagenReporteSecciones(resultado.datosReporteSecciones);
      } catch (e) {
        console.log('[WEBHOOK] Error generando imagen de reporte por secciones:', e.message);
      }
    }

    // MODO DEBUG: si se pide ?debug_imagen=1, devolvemos el PNG
    // directo como respuesta HTTP (para verlo/guardarlo con curl -o),
    // sin necesitar Cloudinary ni WhatsApp reales todavía.
    const url = new URL(request.url);
    if (url.searchParams.get('debug_imagen') === '1' && pngBytes) {
      return new Response(pngBytes, { headers: { 'Content-Type': 'image/png' } });
    }

    // ── 9. Subir a Cloudinary y guardar la URL en el historial ────
    let imagenUrl = null;
    if (pngBytes) {
      try {
        imagenUrl = await subirImagenCloudinary(pngBytes, env, negocio.slug);
        if (resultado.historialId) {
          await env.oficina_ia_db.prepare(
            'UPDATE cuadros_historial SET imagen_url = ? WHERE id = ?'
          ).bind(imagenUrl, resultado.historialId).run();
        }
      } catch (e) {
        // Sin credenciales de Cloudinary configuradas (normal en local
        // sin .dev.vars completo) — no rompe el flujo, solo no hay imagen.
        console.log('[WEBHOOK] Error subiendo a Cloudinary:', e.message);
      }
    }

    // ── 10. Responder por WhatsApp de verdad ───────────────────────
    try {
      let resMeta;
      if (imagenUrl) {
        resMeta = await enviarImagenPorLink(negocio.wa_token, negocio.phone_number_id, numeroCliente, imagenUrl, resultado.mensaje);
      } else if (!resultado.generarExcel && !resultado.generarExcelSecciones && !resultado.generarCarta && !resultado.generarPdf) {
        resMeta = await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, resultado.mensaje);
      }
      if (resMeta) console.log('[WEBHOOK] Respuesta de Meta al enviar mensaje:', JSON.stringify(resMeta));

      // Excel directo por WhatsApp (sube el archivo a Meta, sin pasar por Cloudinary)
      if (resultado.generarExcel && resultado.datosCuadro) {
        const captionExcel = imagenUrl ? 'Aquí está también el Excel, con sus fórmulas:' : resultado.mensaje;
        const resExcel = await enviarExcelCuadro(negocio, numeroCliente, resultado.datosCuadro, captionExcel);
        console.log('[WEBHOOK] Respuesta de Meta al enviar Excel:', JSON.stringify(resExcel));
      }

      // PDF directo por WhatsApp (cotización, factura proforma o cualquier cuadro)
      if (resultado.generarPdf && resultado.datosCuadro) {
        const resPdf = await enviarPdfCuadro(negocio, numeroCliente, resultado.datosCuadro, resultado.mensaje);
        console.log('[WEBHOOK] Respuesta de Meta al enviar PDF:', JSON.stringify(resPdf));
      }

      // Excel del reporte por secciones — mismo patrón, generador distinto
      if (resultado.generarExcelSecciones && resultado.datosReporteSecciones) {
        const captionExcel = imagenUrl ? 'Aquí está también el Excel, con las fórmulas que se pudieron validar:' : resultado.mensaje;
        const resExcelSecciones = await enviarExcelReporteSecciones(negocio, numeroCliente, resultado.datosReporteSecciones, captionExcel);
        console.log('[WEBHOOK] Respuesta de Meta al enviar Excel de secciones:', JSON.stringify(resExcelSecciones));
      }

      // Carta/documento .docx directo por WhatsApp — mismo patrón que el Excel
      if (resultado.generarCarta && resultado.datosCarta) {
        const resCarta = await enviarCartaGenerada(env, negocio, numeroCliente, resultado.datosCarta, resultado.mensaje);
        console.log('[WEBHOOK] Respuesta de Meta al enviar carta:', JSON.stringify(resCarta));
      }
    } catch (e) {
      // Con credenciales de prueba (fake-token) esto va a fallar
      // siempre — es esperado mientras no tengas el número real en Meta.
      console.log('[WEBHOOK] Error enviando por WhatsApp:', e.message);
    }

    return Response.json({
      ok: true,
      negocio: negocio.slug,
      mensaje_usuario: textoUsuario,
      herramienta: llamada.function.name,
      argumentos,
      resultado,
      imagen_generada: !!pngBytes,
      imagen_url: imagenUrl,
    });

  } catch (error) {
    console.error('[WEBHOOK] Error general:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

// ── APLICAR LA ACCIÓN (PARTE 2) ──────────────────────────────────
// Aquí es donde se cumplen las reglas que definimos: Groq ya no
// participa de esto — todo lo de aquí en adelante es determinístico.

async function aplicarAccion(env, negocio, nombreHerramienta, args) {
  // crear_cuadro no necesita un cuadro existente — se resuelve aparte
  if (nombreHerramienta === 'crear_cuadro') {
    return crearCuadro(env, negocio, args);
  }

  // crear_cotizacion tampoco depende de un cuadro existente
  if (nombreHerramienta === 'crear_cotizacion') {
    return crearCotizacion(env, negocio, args, 'cotizacion');
  }
  if (nombreHerramienta === 'crear_factura_proforma') {
    return crearCotizacion(env, negocio, args, 'proforma');
  }
  if (nombreHerramienta === 'convertir_cotizacion_en_factura') {
    return convertirCotizacionEnFactura(env, negocio, args);
  }
  if (nombreHerramienta === 'registrar_pago') {
    return iniciarRegistroPago(env, negocio, args);
  }
  if (nombreHerramienta === 'ajustar_pago') {
    return iniciarAjustePago(env, negocio, args);
  }

  // generar_carta tampoco depende de un cuadro — se resuelve aparte
  if (nombreHerramienta === 'generar_carta') {
    return generarCarta(env, negocio, args);
  }

  const cuadros = await obtenerCuadros(env, negocio.id);
  let cuadro = elegirCuadro(cuadros, args.nombre_cuadro);
  // "el PDF de la cotización 004": si el nombre no coincide exacto, se busca por número
  if (!cuadro && nombreHerramienta === 'enviar_pdf') cuadro = buscarDocumentoGuardado(cuadros, args.nombre_cuadro);

  // Cobro: manda la PERSONA, no el cuadro. Preguntar entre TODOS los cuadros (con cotizaciones y facturas)
  // no sirve, y Groq a veces rellena nombre_cuadro con el cuadro de un mensaje anterior ("Prestamos 2")
  // aunque el usuario no lo dijo. Se usa el cuadro que llegó SOLO si no se pidió a nadie en concreto o si
  // contiene (nombre exacto) a todas las personas pedidas; si no, se busca en los cuadros de préstamo, los
  // mismos que cuenta "¿quién me debe?" (varios → se unen: el cobro es por persona).
  if (nombreHerramienta === 'generar_cobro') {
    const pedidos = [args.nombre, ...(Array.isArray(args.nombres) ? args.nombres : [])].filter(Boolean);
    const cuadroNoSirve = !!cuadro && !cuadroContieneTodos(cuadro, pedidos);
    if (!cuadro || cuadroNoSirve) {
      const prestamos = unirCuadrosDePrestamo(cuadros, normalizarClave);
      if (prestamos) {
        const resultadoCobro = await generarCobro(env, negocio, prestamos.cuadro, prestamos.filas, args);
        if (cuadroNoSirve && resultadoCobro?.mensaje) {
          resultadoCobro.mensaje = `(No encontré a todos en "${cuadro.nombre_cuadro}", así que busqué en tus demás cuadros de préstamo.)\n${resultadoCobro.mensaje}`;
        }
        return resultadoCobro;
      }
    }
  }

  // Abonos: manda la PERSONA, no el cuadro (1b-4b). Groq a veces hereda un cuadro de mensajes anteriores y,
  // con dinero de por medio, el cuadro no puede decidir a quién se abona. Se busca a la persona en los
  // cuadros de préstamo: nombre EXACTO → se registra; nombre solo parecido → vista previa y confirmación.
  if (nombreHerramienta === 'actualizar_fila' && esCampoDeAbono(args.campo)) {
    const respuestaAbono = await resolverAbonoPorPersona(env, negocio, cuadros, cuadro, args);
    if (respuestaAbono) return respuestaAbono;
  }

  if (!cuadro) {
    if (cuadros.length === 0) {
      return { tipo: 'error', mensaje: 'Todavía no tienes ningún cuadro creado. Dime qué columnas quieres y lo armo.' };
    }
    const nombres = cuadros.map(c => c.nombre_cuadro).join(', ');
    return { tipo: 'aviso', mensaje: `Tienes varios cuadros (${nombres}), ¿a cuál te refieres?` };
  }

  const estructura = JSON.parse(cuadro.estructura || '{}');
  const columnas = estructura.columnas || [];
  const reglas = estructura.reglas_calculo || {};
  const subtitulo = estructura.subtitulo || null; // solo lo traen los cuadros importados de una foto
  // encabezado/pie: solo los traen las facturas importadas de una foto —
  // [] en cualquier otro cuadro, y entonces no cambia nada de lo de siempre.
  const extras = { encabezado: estructura.encabezado || [], pie: estructura.pie || [] };
  let filas = JSON.parse(cuadro.filas || '[]');

  if (nombreHerramienta === 'eliminar_cuadro') {
    return pedirConfirmacionEliminarCuadro(env, negocio, cuadro, filas);
  }

  // Reporte tipo "secciones" (ej. Pago de Quincena) — SOLO LECTURA por
  // ahora: se puede consultar (imagen/Excel) pero no editar campo por
  // campo por chat todavía. eliminar_cuadro ya se resolvió arriba,
  // igual para cualquier tipo de cuadro.
  if (estructura.tipo === 'secciones') {
    if (nombreHerramienta === 'enviar_pdf') {
      return { tipo: 'aviso', mensaje: 'El PDF de los reportes por secciones todavía no está disponible. Te puedo mandar el Excel o la imagen.' };
    }
    if (nombreHerramienta === 'consultar_cuadro') {
      return {
        tipo: 'ok',
        mensaje: `Aquí está el reporte "${cuadro.nombre_cuadro}":`,
        generarImagenSecciones: true,
        datosReporteSecciones: estructura,
      };
    }
    if (nombreHerramienta === 'enviar_excel') {
      return {
        tipo: 'ok',
        mensaje: args.con_imagen
          ? `Aquí está el reporte "${cuadro.nombre_cuadro}":`
          : `Aquí está el Excel del reporte "${cuadro.nombre_cuadro}", con las fórmulas que se pudieron validar:`,
        generarExcelSecciones: true,
        generarImagenSecciones: !!args.con_imagen,
        datosReporteSecciones: estructura,
      };
    }
    return {
      tipo: 'aviso',
      mensaje: `El reporte "${cuadro.nombre_cuadro}" todavía no se edita por chat — mándame la foto de nuevo si algo cambió.`,
    };
  }

  if (nombreHerramienta === 'agregar_fila') {
    return agregarFila(env, cuadro, columnas, filas, reglas, args);
  }

  if (nombreHerramienta === 'generar_cobro') {
    return generarCobro(env, negocio, cuadro, filas, args);
  }

  if (nombreHerramienta === 'enviar_excel') {
    return {
      tipo: 'ok',
      mensaje: args.con_imagen
        ? `Aquí está el cuadro "${cuadro.nombre_cuadro}" (${filas.length} registro(s)):`
        : `Aquí está el Excel del cuadro "${cuadro.nombre_cuadro}" (${filas.length} registro(s)), con sus fórmulas:`,
      generarExcel: true,
      generarImagen: !!args.con_imagen,
      datosCuadro: { nombreCuadro: cuadro.nombre_cuadro, columnas, filas, reglas, subtitulo, extras },
    };
  }

  if (nombreHerramienta === 'enviar_pdf') {
    return {
      tipo: 'ok',
      mensaje: `Aquí está el PDF de "${cuadro.nombre_cuadro}":`,
      generarPdf: true,
      datosCuadro: { nombreCuadro: cuadro.nombre_cuadro, columnas, filas, reglas, subtitulo, extras },
    };
  }

  // actualizar_fila, eliminar_fila, y consultar_cuadro CON nombre
  // pasan todas por el mismo fuzzy-match antes de bifurcar.
  if (args.nombre) {
    const busqueda = buscarFila(args.nombre, filas);

    if (busqueda.tipo === 'no_encontrado') {
      return { tipo: 'error', mensaje: `No encontré a "${args.nombre}" en el cuadro "${cuadro.nombre_cuadro}".` };
    }
    if (busqueda.tipo === 'ambiguo') {
      return { tipo: 'aviso', mensaje: busqueda.aviso };
    }

    if (nombreHerramienta === 'consultar_cuadro') {
      // Consulta de UNA persona — respuesta de texto, sin generar imagen del cuadro completo
      return { tipo: 'ok', mensaje: busqueda.aviso || `Esto tengo de ${busqueda.fila.nombre}:`, fila: busqueda.fila };
    }
    if (nombreHerramienta === 'eliminar_fila') {
      return eliminarFila(env, cuadro, columnas, filas, busqueda);
    }
    if (nombreHerramienta === 'actualizar_fila') {
      return actualizarFila(env, cuadro, columnas, filas, reglas, busqueda, args);
    }
  }

  // consultar_cuadro sin nombre → quiere ver el cuadro completo como imagen
  if (nombreHerramienta === 'consultar_cuadro') {
    return {
      tipo: 'ok',
      mensaje: `Aquí está el cuadro "${cuadro.nombre_cuadro}" (${filas.length} registro(s)):`,
      generarImagen: true,
      datosCuadro: { nombreCuadro: cuadro.nombre_cuadro, columnas, filas, subtitulo, extras },
    };
  }

  return { tipo: 'error', mensaje: `No entendí bien qué hacer con "${nombreHerramienta}".` };
}

// ── COTIZACIÓN POR TEXTO/VOZ ─────────────────────────────────────
// Groq solo extrae lo dictado (cliente, líneas, tasas dichas); cotizacion.js
// valida y calcula. El resultado tiene la MISMA forma que una importación por
// foto, así que se guarda como pendiente y se confirma con el mismo flujo
// (vista previa + "sí / no / corregir"). Si falta cantidad o precio, se pregunta.
async function crearCotizacion(env, negocio, args, tipo = 'cotizacion') {
  const config = await leerConfigNegocio(env, negocio.id);
  let membrete = null;
  try { membrete = JSON.parse(config?.membrete_carta || 'null'); } catch (e) { membrete = null; }

  const cuadros = await obtenerCuadros(env, negocio.id);
  const numero = siguienteNumeroDocumento(cuadros.map(c => c.nombre_cuadro), tipo);

  const r = construirDatosCotizacion(args, { membrete, numero, tipo });
  if (!r.ok) return { tipo: 'aviso', mensaje: r.pregunta };

  return {
    tipo: 'cotizacion',
    mensaje: `Preparé la ${tipo === 'proforma' ? 'factura proforma' : 'cotización'} y te la mostré para que la confirmes.`,
    datosImportacion: r.datos,
  };
}

// Copia cliente, líneas y tasas de una cotización ya guardada a una factura
// proforma NUEVA (su propio número y fecha). No depende de la cotización: si
// después se borra o se cambia, la factura proforma no se entera.
async function convertirCotizacionEnFactura(env, negocio, args) {
  const cuadros = await obtenerCuadros(env, negocio.id);
  const e = elegirCotizacion(cuadros, args?.nombre_cuadro);
  if (e.mensaje) return { tipo: 'aviso', mensaje: e.mensaje };

  let estructura, filas;
  try {
    estructura = JSON.parse(e.cuadro.estructura || '{}');
    filas = JSON.parse(e.cuadro.filas || '[]');
  } catch (err) {
    return { tipo: 'aviso', mensaje: `No pude leer la cotización "${e.cuadro.nombre_cuadro}". Dime el cliente y qué lleva, y te hago la factura proforma desde cero.` };
  }
  const l = lineasDesdeCuadro({ nombre_cuadro: e.cuadro.nombre_cuadro, estructura, filas });
  if (!l.ok) return { tipo: 'aviso', mensaje: l.mensaje };

  const config = await leerConfigNegocio(env, negocio.id);
  let membrete = null;
  try { membrete = JSON.parse(config?.membrete_carta || 'null'); } catch (err) { membrete = null; }

  const numero = siguienteNumeroDocumento(cuadros.map(c => c.nombre_cuadro), 'proforma');
  const r = construirDatosCotizacion(
    { cliente: l.cliente, lineas: l.lineas, condicion_pago: args?.condicion_pago },
    { membrete, numero, tipo: 'proforma', referencia: l.referencia }
  );
  if (!r.ok) return { tipo: 'aviso', mensaje: r.pregunta };

  return {
    tipo: 'cotizacion',
    mensaje: `Preparé la factura proforma a partir de "${e.cuadro.nombre_cuadro}" y te la mostré para que la confirmes.`,
    datosImportacion: r.datos,
  };
}

async function crearCuadro(env, negocio, args) {
  // Evitar duplicados: mismo nombre aunque cambien tildes/mayúsculas/espacios
  // (ej. "Préstamos" vs "prestamos " vs "PRESTAMOS" deben contar como el mismo).
  const cuadrosExistentes = await obtenerCuadros(env, negocio.id);
  const nombreNormalizado = normalizarClave(args.nombre_cuadro);
  const yaExiste = cuadrosExistentes.find(c => normalizarClave(c.nombre_cuadro) === nombreNormalizado);
  if (yaExiste) {
    return {
      tipo: 'aviso',
      mensaje: `Ya existe un cuadro llamado "${yaExiste.nombre_cuadro}" — dime si quieres que use ese, o dame otro nombre para crear uno nuevo.`,
    };
  }

  const reglasNormalizadas = normalizarFormulasClaves(args.reglas_calculo, args.columnas || []);

  // Validar TODAS las fórmulas antes de guardar nada — mejor un
  // error claro ahora que un saldo en blanco tres semanas después.
  for (const [campo, formula] of Object.entries(reglasNormalizadas)) {
    const v = validarFormula(formula);
    if (!v.valida) {
      return { tipo: 'error', mensaje: `La fórmula de "${campo}" tiene un error: ${v.error}` };
    }
  }

  const estructura = JSON.stringify({
    columnas: args.columnas || [],
    reglas_calculo: reglasNormalizadas,
  });

  await env.oficina_ia_db.prepare(
    'INSERT INTO cuadros (negocio_id, nombre_cuadro, estructura, filas) VALUES (?, ?, ?, ?)'
  ).bind(negocio.id, args.nombre_cuadro, estructura, '[]').run();

  return { tipo: 'ok', mensaje: `Listo, creé el cuadro "${args.nombre_cuadro}".` };
}

// Guarda/actualiza la carta pendiente de este negocio. "estado" es
// 'capturando' (todavía falta un campo obligatorio) o 'confirmando'
// (ya está todo, esperando que el usuario diga CONFIRMAR o corrija
// algo antes de generar el archivo de verdad).
async function guardarCartaPendiente(env, negocioId, plantillaId, campos, estado) {
  await env.oficina_ia_db.prepare(
    `INSERT INTO cartas_pendientes (negocio_id, plantilla_id, campos_capturados, estado) VALUES (?, ?, ?, ?)
     ON CONFLICT(negocio_id) DO UPDATE SET plantilla_id = excluded.plantilla_id, campos_capturados = excluded.campos_capturados, estado = excluded.estado, creado_en = datetime('now')`
  ).bind(negocioId, plantillaId, JSON.stringify(campos), estado).run();
}

// ── Nombre del negocio (membrete) — se pregunta UNA sola vez ─────
// Nunca bloquea la carta: si la persona no tiene negocio, se genera
// igual, sin encabezado, y no se vuelve a preguntar. El membrete vive
// en configuracion_negocio.membrete_carta (JSON) y el "ya pregunté" en
// configuracion_negocio.otras_prefs — sin tablas ni columnas nuevas.
const PREGUNTA_NEGOCIO =
  '¿Cómo se llama tu negocio? Lo pongo de encabezado en tus cartas (si quieres, dime también la ciudad). ' +
  'Si no tienes negocio, escribe *sin negocio* y la genero igual, sin encabezado.';

async function leerConfigNegocio(env, negocioId) {
  return env.oficina_ia_db.prepare(
    'SELECT membrete_carta, firma_carta, otras_prefs FROM configuracion_negocio WHERE negocio_id = ?'
  ).bind(negocioId).first();
}

function debePreguntarNegocio(config) {
  try {
    if (config?.membrete_carta && JSON.parse(config.membrete_carta)?.nombre) return false;
  } catch (e) { /* membrete mal formado: se trata como "no configurado" */ }
  let prefs = {};
  try { prefs = JSON.parse(config?.otras_prefs || '{}'); } catch (e) { prefs = {}; }
  return !prefs.membrete_preguntado;
}

// datos = { nombre, direccion, ruc } o null (= "sin negocio"). En ambos
// casos queda marcado que ya se preguntó. Combina con lo ya guardado.
async function guardarMembreteNegocio(env, negocioId, datos) {
  const actual = await leerConfigNegocio(env, negocioId);

  let prefs = {};
  try { prefs = JSON.parse(actual?.otras_prefs || '{}'); } catch (e) { prefs = {}; }
  prefs.membrete_preguntado = true;

  let membrete = null;
  if (datos?.nombre) {
    let previo = {};
    try { previo = JSON.parse(actual?.membrete_carta || '{}'); } catch (e) { previo = {}; }
    membrete = { ...previo, nombre: datos.nombre };
    if (datos.direccion) membrete.direccion = datos.direccion;
    if (datos.ruc) membrete.ruc = datos.ruc;
  }

  await env.oficina_ia_db.prepare(
    `INSERT INTO configuracion_negocio (negocio_id, nombre_comercial, membrete_carta, otras_prefs) VALUES (?, ?, ?, ?)
     ON CONFLICT(negocio_id) DO UPDATE SET
       nombre_comercial = COALESCE(excluded.nombre_comercial, configuracion_negocio.nombre_comercial),
       membrete_carta   = COALESCE(excluded.membrete_carta, configuracion_negocio.membrete_carta),
       otras_prefs      = excluded.otras_prefs`
  ).bind(negocioId, datos?.nombre || null, membrete ? JSON.stringify(membrete) : null, JSON.stringify(prefs)).run();
}

function esSinNegocio(texto) {
  const t = normalizarClave(texto.trim());
  return ['no', 'ninguno', 'ninguna', 'no_tengo', 'no_tengo_negocio', 'sin_negocio', 'sin_membrete',
          'sin_encabezado', 'sin_nombre', 'no_aplica', 'omitir', 'saltar'].includes(t)
    || t.startsWith('sin_negocio') || t.startsWith('no_tengo_negocio');
}

// Llamada chica a Groq: SOLO extrae el nombre (y ciudad/RUC si los dijo)
// tal cual, o null si el mensaje no es un nombre de negocio. Nunca decide
// ni inventa nada.
async function interpretarDatosNegocio(texto, groqApiKey) {
  const respuesta = await fetchGroq('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [{
        role: 'user',
        content:
          `Se le preguntó a una persona: "¿Cómo se llama tu negocio?". Del siguiente mensaje extrae SOLO si dice ` +
          `claramente el nombre de un negocio. Responde SOLO con JSON: {"nombre": "...", "direccion": "...", "ruc": "..."}. ` +
          `"direccion" es la ciudad o lugar tal cual lo dijo (opcional); "ruc" solo si lo dijo (opcional). Usa null ` +
          `para lo que NO dijo. Si el mensaje NO es el nombre de un negocio (por ejemplo es una corrección de otro ` +
          `dato, una cédula, una fecha o una pregunta), pon "nombre": null. Nunca inventes nada.\n\n` +
          `Mensaje: "${texto}"`,
      }],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    }),
  });

  const data = await respuesta.json();
  if (data.error) throw new Error(`Groq (negocio): ${data.error.message}`);

  const mensaje = data.choices?.[0]?.message;
  const contenido = (mensaje?.content || mensaje?.reasoning_content || mensaje?.reasoning || '').trim();
  const limpio = contenido.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const d = JSON.parse(limpio);

  const limpiar = (v, max) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
  return { nombre: limpiar(d.nombre, 80), direccion: limpiar(d.direccion, 80), ruc: limpiar(d.ruc, 30) };
}

// Texto sin tildes ni puntuación, para reconocer frases como "sin encabezado".
function textoPlano(texto) {
  return String(texto).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// "Sin encabezado" aplica SOLO a la carta en curso (se guarda como
// _sin_encabezado dentro de los campos de esa carta); NO toca el membrete
// guardado del negocio, que solo cambia con la pregunta del nombre.
// Lo decide el backend con estas frases — nunca Groq.
function pideSinEncabezado(texto) {
  const t = textoPlano(texto);
  return /\bsin (el |mi |ningun )?(encabezado|membrete|negocio|nombre del negocio)\b/.test(t)
    || /\b(quita|quitale|quitar|elimina|eliminar|borra|borrar|omite|omitir|saca|sacar) (el |mi |ese )?(encabezado|membrete)\b/.test(t)
    || /\bno (quiero|pongas|ponga|lleve|lleves|incluyas|uses|usar|necesito)( el| mi| ningun)? (encabezado|membrete)\b/.test(t);
}

function pideConEncabezado(texto) {
  return /\b(con|ponle|poner|pon|agrega|agregar|incluye|incluir) (el |mi |su )?(encabezado|membrete)\b/.test(textoPlano(texto));
}

// Línea "Encabezado: ..." del resumen. Si el negocio no tiene membrete
// no se muestra nada (no se le estorba a quien no tiene negocio).
function lineaEncabezado(config, campos) {
  if (campos._sin_encabezado === true) {
    return { texto: '- Encabezado: ninguno (solo en esta carta)', omitido: true };
  }
  let m = {};
  try { m = JSON.parse(config?.membrete_carta || '{}'); } catch (e) { m = {}; }
  if (m?.nombre) {
    const partes = [m.nombre, m.direccion, m.ruc ? `RUC ${m.ruc}` : null].filter(Boolean);
    return { texto: `- Encabezado: ${partes.join(', ')}`, omitido: false };
  }
  return null;
}

function textoConfirmacionCarta(plantilla, campos, config = null, corregido = false) {
  let bloque = construirResumenCarta(plantilla, campos);
  const enc = lineaEncabezado(config, campos);
  if (enc) bloque += `\n${enc.texto}`;

  const intro = corregido
    ? 'Corregido. Confirma que esto esté bien ahora:'
    : `Antes de generar tu "${plantilla.nombre}", confirma que esto esté bien:`;
  let pie = `Responde CONFIRMAR para generarlo, o dime qué ${corregido ? 'más ' : ''}corregir.`;
  if (enc && !enc.omitido) pie += ' Si no quieres el encabezado del negocio en esta carta, escribe *sin encabezado*.';
  if (enc && enc.omitido) pie += ' Para volver a ponerlo, escribe *con encabezado*.';
  return `${intro}\n\n${bloque}\n\n${pie}`;
}

// Siguiente paso una vez que ya no falta ningún dato de la carta: si el
// negocio aún no tiene membrete y no se le ha preguntado, se pregunta
// una vez; si no, se pasa directo a la confirmación.
async function avanzarCarta(env, negocio, plantilla, campos) {
  const config = await leerConfigNegocio(env, negocio.id);
  if (debePreguntarNegocio(config)) {
    await guardarCartaPendiente(env, negocio.id, plantilla.id, campos, 'preguntando_negocio');
    return { estado: 'preguntando_negocio', mensaje: PREGUNTA_NEGOCIO };
  }
  await guardarCartaPendiente(env, negocio.id, plantilla.id, campos, 'confirmando');
  return { estado: 'confirmando', mensaje: textoConfirmacionCarta(plantilla, campos, config) };
}

// Resumen legible de los datos capturados, para que el usuario los
// revise ANTES de que se genere el archivo — así un error de tipeo
// (una cédula mal escrita, por ejemplo) lo atrapa la propia persona
// viéndolo escrito, en vez de que el sistema adivine si un mensaje
// posterior es una corrección o un nuevo error.
function construirResumenCarta(plantilla, campos) {
  const todos = [...plantilla.camposRequeridos, ...(plantilla.camposOpcionales || [])];
  return todos
    .filter(c => campos[c.id])
    .map(c => `- ${c.etiqueta}: ${capitalizarInicio(campos[c.id])}`)
    .join('\n');
}

// Solo los verbos EXPLÍCITOS cancelan. Antes también cancelaba cualquier
// mensaje que empezara con "no" — y "No, mi cédula es 8-495-291" (la
// forma más natural de corregir un dato viendo el resumen) borraba la
// carta pendiente en vez de corregirla.
function esCancelacion(texto) {
  const primeraPalabra = normalizarClave(texto.trim()).split('_')[0];
  return ['cancela', 'cancelar', 'descarta', 'descartar'].includes(primeraPalabra);
}

// "No" a secas, sin nada más. Su significado depende del momento: viendo
// el resumen de confirmación quiere decir "algo está mal" (no "descártalo");
// cuando el bot pidió un dato que falta, quiere decir "no sigamos".
function esNegacionSola(texto) {
  return normalizarClave(texto.trim()) === 'no';
}

// Palabra de confirmación deliberadamente flexible (no exige la
// palabra EXACTA "CONFIRMAR" como sí hace eliminar_cuadro) — generar
// un documento no es tan irreversible como borrar un cuadro completo,
// y aquí la protección real ya está en que el usuario VE los datos
// antes de aceptar.
function esConfirmacionAfirmativa(texto) {
  const t = normalizarClave(texto.trim());
  if (t.startsWith('confirmar')) return true;
  return ['confirmar', 'confirmo', 'si', 'correcto', 'dale', 'ok', 'okay', 'listo', 'perfecto'].includes(t);
}

// ── CARTAS/DOCUMENTOS (generar_carta) ────────────────────────────
// Groq solo elige la plantilla (por "id" exacto del catálogo) y
// extrae los datos crudos que el usuario dictó — nunca decide si
// "ya es suficiente": eso lo decide camposFaltantes() en JS puro.
// Si falta algo, se guarda como pendiente (mismo patrón que
// importaciones_pendientes) y se pregunta TODO lo que falte de una
// sola vez, no campo por campo. Cuando ya no falta nada, TAMPOCO se
// genera de una vez — se pide confirmación mostrando los datos, para
// que un error de tipeo del usuario se note ANTES de crear el
// archivo, no después.

async function generarCarta(env, negocio, args) {
  const plantilla = args.tipo_carta ? await obtenerPlantilla(env, args.tipo_carta) : null;

  if (!plantilla) {
    const disponibles = await listarPlantillasParaPrompt(env);
    if (disponibles.length === 0) {
      return { tipo: 'error', mensaje: 'Todavía no tengo cartas configuradas para este negocio.' };
    }
    const nombres = disponibles.map(p => p.nombre).join(', ');
    return { tipo: 'aviso', mensaje: `¿Qué documento necesitas? Puedo generar: ${nombres}.` };
  }

  // Defensivo: si Groq manda una clave con mayúscula por error, solo
  // normalizamos minúsculas/espacios — normalizarClave() destruiría
  // el guión bajo de ids como "cedula_solicitante" (ver nota más abajo
  // donde se usa normalizarClave para otra cosa).
  const campos = {};
  for (const [clave, valor] of Object.entries(args.campos || {})) {
    if (valor !== null && valor !== undefined && String(valor).trim() !== '') {
      campos[String(clave).trim().toLowerCase()] = String(valor).trim();
    }
  }

  const faltantes = camposFaltantes(plantilla, campos);

  if (faltantes.length > 0) {
    await guardarCartaPendiente(env, negocio.id, plantilla.id, campos, 'capturando');
    const preguntas = faltantes.map(c => `- ${c.etiqueta}`).join('\n');
    return {
      tipo: 'aviso',
      mensaje: `Para armar tu "${plantilla.nombre}" me falta:\n${preguntas}\n\nMándamelo y te la genero.`,
    };
  }

  const siguiente = await avanzarCarta(env, negocio, plantilla, campos);
  return { tipo: 'aviso', mensaje: siguiente.mensaje };
}

// Se llama cuando ya había una carta pendiente (capturando datos o
// esperando confirmación) y llega un mensaje nuevo.
async function procesarRespuestaCartaPendiente(env, negocio, numeroCliente, texto, cartaPendiente) {
  const estadoActual = cartaPendiente.estado || 'capturando';

  if (estadoActual === 'confirmando' && esNegacionSola(texto)) {
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
      '¿Qué quieres corregir? Dímelo y lo ajusto (o escribe CANCELAR para descartar el documento).');
    return Response.json({ ok: true, carta_esperando_correccion: true });
  }

  if (esCancelacion(texto) || (estadoActual === 'capturando' && esNegacionSola(texto))) {
    await env.oficina_ia_db.prepare('DELETE FROM cartas_pendientes WHERE negocio_id = ?').bind(negocio.id).run();
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
      'Cancelado — no generé el documento. Pídemelo de nuevo cuando quieras.');
    return Response.json({ ok: true, carta_cancelada: true });
  }

  const plantilla = await obtenerPlantilla(env, cartaPendiente.plantilla_id);
  if (!plantilla) {
    await env.oficina_ia_db.prepare('DELETE FROM cartas_pendientes WHERE negocio_id = ?').bind(negocio.id).run();
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
      'Esa plantilla ya no está disponible — pídeme el documento de nuevo.');
    return Response.json({ ok: true, error: 'plantilla_no_encontrada' });
  }

  const yaCapturados = JSON.parse(cartaPendiente.campos_capturados || '{}');
  const estado = cartaPendiente.estado || 'capturando';

  // ── Preguntando el nombre del negocio (una sola vez) ──────────
  if (estado === 'preguntando_negocio') {
    // "Sin negocio" / "no tengo": se genera igual, sin encabezado, y
    // queda marcado para no volver a preguntar.
    if (esSinNegocio(texto)) {
      await guardarMembreteNegocio(env, negocio.id, null);
      await guardarCartaPendiente(env, negocio.id, plantilla.id, yaCapturados, 'confirmando');
      await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
        `Sin problema, la carta saldrá sin encabezado.\n\n${textoConfirmacionCarta(plantilla, yaCapturados)}`);
      return Response.json({ ok: true, carta_sin_negocio: true });
    }

    let datosNegocio = null;
    try {
      datosNegocio = await interpretarDatosNegocio(texto, env.GROQ_API_KEY);
    } catch (e) {
      console.log('[WEBHOOK] Error interpretando el nombre del negocio:', e.message);
    }

    if (datosNegocio?.nombre) {
      await guardarMembreteNegocio(env, negocio.id, datosNegocio);
      await guardarCartaPendiente(env, negocio.id, plantilla.id, yaCapturados, 'confirmando');
      const configNueva = await leerConfigNegocio(env, negocio.id);
      await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
        `Listo, guardé tu negocio. Desde ahora tus cartas llevarán ese encabezado.\n\n${textoConfirmacionCarta(plantilla, yaCapturados, configNueva)}`);
      return Response.json({ ok: true, negocio_configurado: true });
    }

    // No parece un nombre de negocio: puede ser una corrección de los
    // datos de la carta (ej. "No, mi cédula es..."). Se aplica y se
    // vuelve a preguntar — nunca se toma como nombre de negocio.
    let correccion = {};
    try {
      correccion = await interpretarCamposFaltantes(texto, plantilla, yaCapturados, env.GROQ_API_KEY);
    } catch (e) {
      console.log('[WEBHOOK] Error interpretando corrección durante la pregunta del negocio:', e.message);
    }
    const huboCorreccion = Object.keys(correccion).length > 0;
    if (huboCorreccion) {
      await guardarCartaPendiente(env, negocio.id, plantilla.id, { ...yaCapturados, ...correccion }, 'preguntando_negocio');
    }
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
      `${huboCorreccion ? 'Anotado. ' : ''}${PREGUNTA_NEGOCIO}`);
    return Response.json({ ok: true, carta_esperando_negocio: true });
  }

  // ── Esperando confirmación final ──────────────────────────────
  if (estado === 'confirmando') {
    if (esConfirmacionAfirmativa(texto)) {
      await env.oficina_ia_db.prepare('DELETE FROM cartas_pendientes WHERE negocio_id = ?').bind(negocio.id).run();
      const resCarta = await enviarCartaGenerada(
        env, negocio, numeroCliente,
        { plantillaId: plantilla.id, campos: yaCapturados },
        `Listo, aquí está tu "${plantilla.nombre}":`
      );
      console.log('[WEBHOOK] Respuesta de Meta al enviar carta (confirmada):', JSON.stringify(resCarta));
      return Response.json({ ok: true, carta_completada: true });
    }

    // "Sin encabezado" / "con encabezado": aplica solo a ESTA carta.
    if (pideSinEncabezado(texto) || (yaCapturados._sin_encabezado === true && pideConEncabezado(texto))) {
      const quitar = pideSinEncabezado(texto);
      const nuevos = { ...yaCapturados };
      if (quitar) nuevos._sin_encabezado = true; else delete nuevos._sin_encabezado;
      const config = await leerConfigNegocio(env, negocio.id);
      await guardarCartaPendiente(env, negocio.id, plantilla.id, nuevos, 'confirmando');
      await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
        `${quitar ? 'Listo, esta carta saldrá sin encabezado.' : 'Listo, esta carta llevará el encabezado de tu negocio.'}\n\n${textoConfirmacionCarta(plantilla, nuevos, config)}`);
      return Response.json({ ok: true, carta_encabezado_cambiado: true });
    }

    // No dijo que sí ni canceló -> se trata como una corrección.
    // interpretarCamposFaltantes() ya sabe manejar esto: como aquí no
    // falta ningún campo obligatorio, todos los que ya tienen valor se
    // listan como "corregibles si el usuario los repite en este mensaje".
    let correccion;
    try {
      correccion = await interpretarCamposFaltantes(texto, plantilla, yaCapturados, env.GROQ_API_KEY);
    } catch (e) {
      console.log('[WEBHOOK] Error interpretando corrección de carta:', e.message);
      correccion = {};
    }

    const camposActualizados = { ...yaCapturados, ...correccion };
    const faltantesAhora = camposFaltantes(plantilla, camposActualizados);

    if (faltantesAhora.length > 0) {
      // Caso raro: una "corrección" dejó vacío un campo obligatorio.
      // Mejor volver a pedirlo que confirmar algo incompleto.
      await guardarCartaPendiente(env, negocio.id, plantilla.id, camposActualizados, 'capturando');
      const preguntas = faltantesAhora.map(c => `- ${c.etiqueta}`).join('\n');
      await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, `Todavía me falta:\n${preguntas}`);
      return Response.json({ ok: true, carta_datos_incompletos: true });
    }

    await guardarCartaPendiente(env, negocio.id, plantilla.id, camposActualizados, 'confirmando');
    const config = await leerConfigNegocio(env, negocio.id);
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
      textoConfirmacionCarta(plantilla, camposActualizados, config, true));
    return Response.json({ ok: true, carta_en_revision: true });
  }

  // ── Todavía capturando datos obligatorios ─────────────────────
  let extraidos;
  try {
    extraidos = await interpretarCamposFaltantes(texto, plantilla, yaCapturados, env.GROQ_API_KEY);
  } catch (e) {
    console.log('[WEBHOOK] Error interpretando campos faltantes de carta:', e.message);
    extraidos = {};
  }

  const camposActualizados = { ...yaCapturados, ...extraidos };
  const faltantesAhora = camposFaltantes(plantilla, camposActualizados);

  if (faltantesAhora.length > 0) {
    await guardarCartaPendiente(env, negocio.id, plantilla.id, camposActualizados, 'capturando');
    const preguntas = faltantesAhora.map(c => `- ${c.etiqueta}`).join('\n');
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, `Todavía me falta:\n${preguntas}`);
    return Response.json({ ok: true, carta_datos_incompletos: true });
  }

  // Ya está todo -> siguiente paso (preguntar el negocio una vez, o
  // confirmar). NUNCA se genera directo aquí.
  const siguiente = await avanzarCarta(env, negocio, plantilla, camposActualizados);
  await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, siguiente.mensaje);
  return Response.json({ ok: true, carta_siguiente_paso: siguiente.estado });
}

// Llamada chica y aparte a Groq para completar una carta pendiente.
// Dos trabajos, en el mismo mensaje:
//   1. Extraer los valores de los campos que TODAVÍA faltan.
//   2. Si el usuario dio, de paso, un dato adicional relevante que no
//      corresponde a ningún campo (ej. apartamento, fecha, horario),
//      sumarlo al texto del "campo libre" (el ÚLTIMO campo requerido
//      de la plantilla — ej. "motivo" en solicitud, "gestion" en
//      poder) en vez de perderlo. Nunca inventa nada que el usuario
//      no haya dicho.
async function interpretarCamposFaltantes(texto, plantilla, yaCapturados, groqApiKey) {
  const faltan = camposFaltantes(plantilla, yaCapturados);
  const listaFaltan = faltan.length > 0
    ? faltan.map(c => `- "${c.id}": ${c.etiqueta}`).join('\n')
    : '(ninguno — ya están todos los obligatorios)';

  const camposDef = plantilla.camposRequeridos;
  const campoLibre = camposDef[camposDef.length - 1];
  const textoActualCampoLibre = yaCapturados[campoLibre.id] || '';

  // Campos que YA tienen valor (aparte del campo libre, que tiene su
  // propia instrucción de "agregar" más abajo). Se listan con su valor
  // actual para permitir CORRECCIONES: si el usuario repite/corrige
  // uno de estos en este mismo mensaje (ej. dio mal una cédula antes y
  // la vuelve a dar distinta), debe poder sobrescribirse. Si el
  // usuario no lo menciona en este mensaje, Groq no debe tocarlo.
  const todosLosCampos = [...plantilla.camposRequeridos, ...(plantilla.camposOpcionales || [])];
  const otrosYaCapturados = todosLosCampos.filter(c => c.id !== campoLibre.id && yaCapturados[c.id]);
  const listaOtros = otrosYaCapturados.length > 0
    ? otrosYaCapturados.map(c => `- "${c.id}" (${c.etiqueta}): valor actual "${yaCapturados[c.id]}"`).join('\n')
    : '(ninguno)';

  const respuesta = await fetchGroq('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [{
        role: 'user',
        content:
          `El usuario está completando (o corrigiendo) los datos de un documento.\n\n` +
          `Campos OBLIGATORIOS que todavía faltan — extrae su valor si el usuario lo da en este mensaje:\n${listaFaltan}\n\n` +
          `Estos otros campos YA tienen un valor capturado:\n${listaOtros}\n` +
          `Si en ESTE mensaje el usuario da un valor NUEVO para alguno de estos (ej. para corregir un dato que ` +
          `dio mal antes, como una cédula), inclúyelo en la respuesta con el valor nuevo. Si NO lo menciona en ` +
          `este mensaje, NO lo incluyas en la respuesta — nunca lo sobrescribas con algo que el usuario no dijo aquí.\n\n` +
          `Además, "${campoLibre.id}" (${campoLibre.etiqueta}) es el campo LIBRE de este documento — ya tiene ` +
          `este texto capturado: "${textoActualCampoLibre}". Si en el mensaje el usuario da un dato adicional ` +
          `relevante para el documento que no corresponde a ningún otro campo (ej. un número de apartamento, ` +
          `una fecha, un horario), redacta "${campoLibre.id}" de nuevo agregando ese dato de forma natural al ` +
          `texto que ya tenía — no lo omitas. ${REGLA_CAMPO_LIBRE} Si no hay nada nuevo que agregar a "${campoLibre.id}", no lo ` +
          `incluyas en la respuesta.\n\n` +
          `Del siguiente mensaje, extrae ÚNICAMENTE los valores que el usuario dio, tal cual los dijo, sin ` +
          `inventar. Responde SOLO con JSON, usando EXACTAMENTE los ids de campo como claves: ` +
          `{"id_del_campo": "valor", ...}.\n\n` +
          `Mensaje del usuario: "${texto}"`,
      }],
      temperature: 0,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    }),
  });

  const data = await respuesta.json();
  if (data.error) throw new Error(`Groq (campos de carta): ${data.error.message}`);

  const mensaje = data.choices?.[0]?.message;
  const contenido = (mensaje?.content || mensaje?.reasoning_content || mensaje?.reasoning || '').trim();
  const limpio = contenido.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(limpio);
}

async function agregarFila(env, cuadro, columnas, filas, reglas, args) {
  // Si ya existe alguien con ese nombre, avisamos en vez de crear un duplicado
  const yaExiste = buscarFila(args.nombre, filas);
  if (yaExiste.tipo === 'exacto') {
    return { tipo: 'aviso', mensaje: `Ya existe "${args.nombre}" en el cuadro — ¿querías actualizar su registro en vez de agregar uno nuevo?` };
  }

  const nuevaFilaCruda = { nombre: args.nombre, ...limpiarValores(args.valores) };
  const filaCalculada = calcularFila(nuevaFilaCruda, reglas);

  const filasAntes = JSON.stringify(filas);
  filas.push(filaCalculada);
  const historialId = await guardarCuadro(env, cuadro.id, filas, filasAntes);

  // Si el usuario dio el teléfono desde el principio, lo guardamos de una vez.
  // Si no pasa la validación, la fila se agrega igual pero se le avisa (antes se descartaba en silencio).
  let notaTelefono = '';
  if (args.telefono) {
    try {
      const resTel = await resolverTelefonoContacto(env, cuadro.negocio_id, args.nombre, args.telefono);
      if (resTel.aviso) notaTelefono = `\n⚠️ ${resTel.aviso}`;
    } catch (e) {
      console.log('[WEBHOOK] Error guardando teléfono en agregar_fila:', e.message);
    }
  }

  return {
    tipo: 'ok',
    mensaje: `Agregué a ${args.nombre} al cuadro.${notaTelefono}`,
    fila: filaCalculada,
    historialId,
    generarImagen: true,
    datosCuadro: { nombreCuadro: cuadro.nombre_cuadro, columnas, filas },
  };
}

// ── COBRO ASISTIDO (generar_cobro) ───────────────────────────────
// El bot nunca le escribe al deudor — arma el mensaje y el enlace
// wa.me para que el USUARIO se lo reenvíe él mismo desde su propio
// WhatsApp. Esto mantiene el gasto de Meta en $0 (nunca sale un
// mensaje del bot hacia el deudor) y evita cualquier riesgo de
// que Meta marque el número por spam.

const TOPE_LISTA_GENERICA = 10;

async function generarCobro(env, negocio, cuadro, filas, args) {
  // Modo 1: una sola persona nombrada — comportamiento ya probado, sin cambios
  if (args.nombre) {
    return generarCobroIndividual(env, negocio, cuadro, filas, args.nombre, args.telefono);
  }

  // Modo 2 y 3: lista — nombres específicos, o genérica con tope
  let destinatarios;
  let notaExtra = '';

  if (args.nombres && args.nombres.length > 0) {
    destinatarios = [];
    for (const nombreMencionado of args.nombres) {
      const busqueda = buscarFila(nombreMencionado, filas);
      if (busqueda.tipo === 'ambiguo') {
        return { tipo: 'aviso', mensaje: busqueda.aviso };
      }
      if (busqueda.tipo === 'no_encontrado') {
        notaExtra += `No encontré a "${nombreMencionado}", lo salté. `;
        continue;
      }
      if (!(busqueda.fila.saldo > 0)) {
        notaExtra += `${busqueda.fila.nombre} no tiene saldo pendiente, lo salté. `;
        continue;
      }
      destinatarios.push(busqueda.fila);
    }
  } else {
    // Modo genérico: todos los que tengan saldo > 0, los de mayor saldo primero
    const deudores = filas
      .filter(f => typeof f.saldo === 'number' && f.saldo > 0)
      .sort((a, b) => b.saldo - a.saldo);
    destinatarios = deudores.slice(0, TOPE_LISTA_GENERICA);
    if (deudores.length > TOPE_LISTA_GENERICA) {
      notaExtra = `Hay ${deudores.length - TOPE_LISTA_GENERICA} más con saldo pendiente — pídeme "los siguientes" si quieres verlos.`;
    }
  }

  if (destinatarios.length === 0) {
    return { tipo: 'ok', mensaje: `No encontré a nadie con saldo pendiente para cobrar.${notaExtra ? ' ' + notaExtra : ''}` };
  }

  // Resolver teléfonos ya guardados — en modo lista NUNCA se pide uno
  // nuevo por persona (sería mucha fricción), solo se usa lo que ya existe
  const conTelefono = [];
  const sinTelefono = [];
  for (const fila of destinatarios) {
    const res = await resolverTelefonoContacto(env, negocio.id, fila.nombre, null);
    if (res.telefono) {
      conTelefono.push({ ...fila, telefono: res.telefono });
    } else {
      sinTelefono.push(fila.nombre);
    }
  }

  if (conTelefono.length === 0) {
    return {
      tipo: 'aviso',
      mensaje: `No tengo el teléfono de ninguno todavía (${destinatarios.map(d => d.nombre).join(', ')}) — pásamelos uno por uno y te preparo los cobros.`,
    };
  }

  let mensajesRedactados;
  try {
    mensajesRedactados = await redactarMensajesCobroMasivo(env, conTelefono, negocio.nombre);
  } catch (e) {
    console.log('[WEBHOOK] Error redactando cobros masivos:', e.message);
    return { tipo: 'error', mensaje: 'No pude redactar los mensajes de cobro, intenta de nuevo.' };
  }

  let mensajeFinal = `📊 Lista de cobros (${conTelefono.length}):\n\n`;
  for (let i = 0; i < conTelefono.length; i++) {
    const d = conTelefono[i];
    const telefonoLimpio = String(d.telefono).replace(/\D/g, '');
    const texto = mensajesRedactados[i] || `Hola ${d.nombre}, te recuerdo que tienes un saldo pendiente de $${Number(d.saldo).toFixed(2)}.`;
    const enlaceLargo = `https://wa.me/${telefonoLimpio}?text=${encodeURIComponent(texto)}`;
    const enlace = await acortarEnlace(env, enlaceLargo);
    mensajeFinal += `👤 ${d.nombre} (Debe: $${Number(d.saldo).toFixed(2)})\n📝 "${texto}"\n👉 ${enlace}\n`;
    if (i < conTelefono.length - 1) mensajeFinal += `───────────────────\n`;
  }

  if (sinTelefono.length > 0) {
    mensajeFinal += `\n⚠️ Sin teléfono guardado (no se generó cobro): ${sinTelefono.join(', ')}`;
  }
  if (notaExtra) mensajeFinal += `\n\n${notaExtra}`;

  return { tipo: 'ok', mensaje: mensajeFinal };
}

async function generarCobroIndividual(env, negocio, cuadro, filas, nombreArg, telefonoArg) {
  const busqueda = buscarFila(nombreArg, filas);

  if (busqueda.tipo === 'no_encontrado') {
    return { tipo: 'error', mensaje: `No encontré a "${nombreArg}" en ${cuadro.unido ? 'tus cuadros de préstamo' : `el cuadro "${cuadro.nombre_cuadro}"`}.` };
  }
  if (busqueda.tipo === 'ambiguo') {
    return { tipo: 'aviso', mensaje: busqueda.aviso };
  }

  const saldo = busqueda.fila.saldo;
  if (saldo === undefined || saldo === null) {
    return { tipo: 'error', mensaje: `No tengo un saldo calculado para ${busqueda.fila.nombre} todavía.` };
  }
  if (saldo <= 0) {
    return { tipo: 'ok', mensaje: `${busqueda.fila.nombre} no tiene saldo pendiente — no hace falta cobrarle.` };
  }

  const resContacto = await resolverTelefonoContacto(env, negocio.id, busqueda.fila.nombre, telefonoArg || null);

  if (resContacto.aviso) {
    return { tipo: 'aviso', mensaje: resContacto.aviso };
  }
  if (!resContacto.telefono) {
    return { tipo: 'aviso', mensaje: `No tengo el teléfono de ${busqueda.fila.nombre} todavía — pásamelo y te preparo el cobro.` };
  }

  let mensajeRedactado;
  try {
    mensajeRedactado = await redactarMensajeCobro(env, busqueda.fila.nombre, saldo, negocio.nombre);
  } catch (e) {
    console.log('[WEBHOOK] Error redactando cobro:', e.message);
    return { tipo: 'error', mensaje: 'No pude redactar el mensaje de cobro, intenta de nuevo.' };
  }

  const telefonoLimpio = String(resContacto.telefono).replace(/\D/g, '');
  const enlaceLargo = `https://wa.me/${telefonoLimpio}?text=${encodeURIComponent(mensajeRedactado)}`;
  const enlace = await acortarEnlace(env, enlaceLargo);

  return {
    tipo: 'ok',
    mensaje: `Aquí tienes el mensaje para ${busqueda.fila.nombre}:\n\n"${mensajeRedactado}"\n\n👉 ${enlace}`,
  };
}

// Busca al contacto por nombre (mismo fuzzy-match de siempre).
// - Teléfono nuevo: se VALIDA antes de tocar nada (8 dígitos, o 507 + 8). Si no es válido no se guarda
//   y se devuelve un `aviso`. Si el contacto coincide EXACTO se actualiza; si no existe, o solo hay uno
//   parecido (coincidencia aproximada), se CREA uno nuevo: nunca se pisa el teléfono de otra persona.
// - Sin teléfono nuevo: devuelve el que ya exista SOLO con coincidencia exacta (un nombre parecido no sirve
//   para un mensaje de cobro: iría a otra persona); null si nunca se guardó. Un teléfono guardado que
//   ya no pasa la validación (datos viejos) se trata como no válido y se pide de nuevo.
async function resolverTelefonoContacto(env, negocioId, nombre, telefonoNuevo) {
  const { results: contactos } = await env.oficina_ia_db.prepare(
    'SELECT * FROM contactos_negocio WHERE negocio_id = ?'
  ).bind(negocioId).all();

  const encontrado = buscarFila(nombre, contactos);

  if (telefonoNuevo) {
    const valido = normalizarTelefonoPanama(telefonoNuevo);
    if (!valido.ok) {
      return { telefono: null, aviso: mensajeTelefonoInvalido(telefonoNuevo, valido) };
    }
    if (encontrado.tipo === 'exacto') {
      await env.oficina_ia_db.prepare(
        'UPDATE contactos_negocio SET telefono = ? WHERE id = ?'
      ).bind(valido.telefono, encontrado.fila.id).run();
    } else if (encontrado.tipo !== 'ambiguo') {
      await env.oficina_ia_db.prepare(
        'INSERT INTO contactos_negocio (negocio_id, nombre, telefono, tipo) VALUES (?, ?, ?, ?)'
      ).bind(negocioId, nombre, valido.telefono, 'cliente_final').run();
    }
    return { telefono: valido.telefono };
  }

  if (encontrado.tipo === 'ambiguo') {
    return { telefono: null, aviso: encontrado.aviso };
  }
  if (encontrado.tipo === 'exacto') {
    const guardado = encontrado.fila.telefono;
    if (!guardado) return { telefono: null };
    const valido = normalizarTelefonoPanama(guardado);
    if (!valido.ok) {
      return { telefono: null, aviso: `El teléfono guardado de ${encontrado.fila.nombre} no es válido (${String(guardado).slice(0, 20)}). Pásamelo de nuevo, con 8 dígitos.` };
    }
    return { telefono: valido.telefono };
  }
  return { telefono: null };
}

// Segunda llamada a Groq, SEPARADA de la que elige la herramienta —
// esta solo redacta. El monto y el nombre ya vienen resueltos por
// el backend; Groq nunca ve el cuadro completo ni decide el número.
async function redactarMensajeCobro(env, nombreDeudor, monto, nombreQuienCobra) {
  const montoTexto = Number(monto).toFixed(2);

  const prompt = `Ayuda a ${nombreQuienCobra} a redactar un mensaje de cobro amable para enviarle a ${nombreDeudor}, quien le debe $${montoTexto}.

Reglas del mensaje:
- Tono panameño, cercano, respetuoso — nunca agresivo ni amenazante.
- Puedes usar frases típicas como "cuando tengas un chance", "por Yappy", "bendiciones", pero no las metas todas a la fuerza en cada mensaje.
- Menciona el monto exacto ($${montoTexto}).
- Escríbelo en primera persona, como si ${nombreQuienCobra} se lo estuviera escribiendo directamente a ${nombreDeudor}.
- Máximo 3-4 líneas cortas, como un mensaje real de WhatsApp, no una carta formal.
- Responde SOLO con el texto del mensaje, sin comillas ni explicación adicional.`;

  const res = await fetchGroq('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  const texto = data.choices?.[0]?.message?.content?.trim();
  if (!texto) throw new Error('Groq no devolvió texto');
  return texto;
}

// Versión "en lote" para el modo lista — UNA sola llamada a Groq
// para redactar todos los mensajes de una vez (más barato en tokens
// que una llamada por persona, y de paso salen con variedad entre
// sí porque el modelo los ve juntos).
async function redactarMensajesCobroMasivo(env, destinatarios, nombreQuienCobra) {
  const lista = destinatarios
    .map((d, i) => `${i + 1}. ${d.nombre} — debe $${Number(d.saldo).toFixed(2)}`)
    .join('\n');

  const prompt = `Ayuda a ${nombreQuienCobra} a redactar ${destinatarios.length} mensajes de cobro amables, uno para cada persona de esta lista:
${lista}

Reglas:
- Tono panameño, cercano, respetuoso — nunca agresivo.
- Varía el estilo entre mensajes (no los hagas todos con la misma estructura).
- Puedes usar frases como "cuando tengas un chance", "por Yappy", "bendiciones", pero no en todos a la fuerza.
- Cada mensaje en primera persona, como si ${nombreQuienCobra} se lo escribiera directo a esa persona.
- Máximo 3-4 líneas cortas cada uno, como un mensaje real de WhatsApp.
- Responde ÚNICAMENTE con un array JSON de strings, en el MISMO ORDEN que la lista, sin texto adicional ni bloques de código. Ejemplo: ["mensaje para el 1","mensaje para el 2"]`;

  const res = await fetchGroq('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);

  let texto = data.choices?.[0]?.message?.content?.trim() || '';
  // Por si Groq lo envuelve en ```json ... ``` a pesar de la instrucción
  texto = texto.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

  const arreglo = JSON.parse(texto);
  if (!Array.isArray(arreglo)) throw new Error('Groq no devolvió un arreglo JSON');
  return arreglo;
}

async function actualizarFila(env, cuadro, columnas, filas, reglas, busqueda, args) {
  const filasAntes = JSON.stringify(filas);
  const campoNormalizado = normalizarClave(args.campo);

  // Columna de abono (abono, abono_a_capital…): el valor se SUMA al acumulado y queda un pago
  // `abono_prestamo`. Si la columna es calculada por una regla del cuadro, no es un dato a sumar.
  // Se prueba también el campo tal cual llegó: normalizarClave quita los "_" y un campo que ya viene
  // como clave ("abono_a_capital") se convertiría en "abonoacapital".
  const clavesColumnas = columnas.map(normalizarClave);
  const claveAbono = columnaDePago(campoNormalizado, clavesColumnas)
    || columnaDePago(String(args.campo ?? '').toLowerCase().trim(), clavesColumnas);
  if (claveAbono && !Object.prototype.hasOwnProperty.call(reglas, claveAbono)) {
    return await abonarEnCuadro(env, cuadro, columnas, filas, reglas, busqueda, args, claveAbono, filasAntes);
  }

  const valorLimpio = limpiarValor(args.valor);
  const filaActualizada = calcularFila({ ...busqueda.fila, [campoNormalizado]: valorLimpio }, reglas);

  filas = filas.map(f => (f === busqueda.fila ? filaActualizada : f));
  const historialId = await guardarCuadro(env, cuadro.id, filas, filasAntes);

  const prefijo = busqueda.tipo === 'alto' ? `${busqueda.aviso} ` : '';
  return {
    tipo: 'ok',
    mensaje: `${prefijo}Actualicé ${campoNormalizado} de ${filaActualizada.nombre}.`,
    fila: filaActualizada,
    historialId,
    generarImagen: true,
    datosCuadro: { nombreCuadro: cuadro.nombre_cuadro, columnas, filas },
  };
}

// "Yisel abonó 10": busca a la persona en TODOS los cuadros de préstamo (ver pagos.js). Devuelve null cuando
// el flujo de siempre debe seguir (negocio sin préstamos, o un cuadro propio con columna de abono).
async function resolverAbonoPorPersona(env, negocio, cuadros, cuadroGroq, args) {
  const prestamos = cuadros.filter(c => esCuadroDePrestamo(c, normalizarClave));
  if (prestamos.length === 0) return null;
  if (cuadroGroq && !esCuadroDePrestamo(cuadroGroq, normalizarClave) && tieneColumnaAbono(cuadroGroq, normalizarClave)) return null;

  const aviso = mensaje => ({ tipo: 'aviso', mensaje, cerrarFlujo: true });
  if (esCorreccionDeAbono(args._texto)) return aviso(textoRechazoCorreccionAbono(args.nombre));

  const hallazgo = buscarPersonaEnPrestamos(args.nombre, prestamos, normalizarClave, buscarFila, args._texto);
  if (hallazgo.tipo === 'ninguno') return aviso(textoNingunoEnPrestamos(args.nombre));
  if (hallazgo.tipo === 'exacto_varios') return aviso(textoVariosExactos(args.nombre, hallazgo.coincidencias));
  if (hallazgo.tipo === 'parecidos') return aviso(textoParecidos(args.nombre, hallazgo.candidatos));

  const { cuadro, filas, fila } = hallazgo;
  let estructura;
  try { estructura = JSON.parse(cuadro.estructura); } catch { return null; }
  const columnas = estructura.columnas;
  const reglas = estructura.reglas_calculo || {};
  const claveAbono = resolverClaveAbono(args.campo, columnas, normalizarClave);
  if (!claveAbono) {
    return aviso(`El cuadro "${cuadro.nombre_cuadro}" tiene más de una columna de abono. Dime a cuál va, por ejemplo: "abono a capital".`);
  }
  const filasAntes = JSON.stringify(filas);

  if (hallazgo.tipo === 'exacto') {
    // Si el usuario nombró un cuadro y la persona está en otro, se le avisa dónde quedó registrado.
    const todosLosNombres = cuadros.map(c => c.nombre_cuadro);
    const notaCuadro = cuadroGroq && cuadroGroq.id !== cuadro.id && mencionaCuadro(args._texto, cuadroGroq.nombre_cuadro, todosLosNombres)
      ? `Ojo: dijiste "${cuadroGroq.nombre_cuadro}", pero ${fila.nombre} está en "${cuadro.nombre_cuadro}", así que lo registré ahí.`
      : null;
    return await abonarEnCuadro(env, cuadro, columnas, filas, reglas, { tipo: 'exacto', fila }, { ...args, _notaCuadro: notaCuadro }, claveAbono, filasAntes);
  }

  // Nombre solo PARECIDO: nunca se registra solo.
  const r = acumularAbono(fila[claveAbono], args.valor);
  if (!r.ok) return aviso('No entendí el monto del abono. Dime cuánto abonó, por ejemplo: "Yisel abonó 10".');
  const despues = calcularFila({ ...fila, [claveAbono]: r.nuevo }, reglas);
  await guardarPagoPendiente(env, negocio.id, {
    tipoPendiente: 'abono', cuadroId: cuadro.id, nombreFila: fila.nombre, nombreDicho: args.nombre,
    campo: args.campo, valor: String(args.valor), mensajeId: args._mensajeId || null,
  });
  return {
    tipo: 'pago_pendiente',
    mensaje: textoConfirmarAbonoParecido({
      dicho: args.nombre, nombre: fila.nombre, cuadro: cuadro.nombre_cuadro, monto: r.monto,
      abonoAntes: r.previo, abonoDespues: r.nuevo, saldoAntes: Number(fila.saldo), saldoDespues: Number(despues.saldo),
    }),
  };
}

// Respuesta "sí / no" a un abono con nombre parecido. Primero se "reclama" el pendiente (si otro mensaje
// repetido ya lo consumió, no se registra dos veces) y los datos se vuelven a leer del cuadro de ahora.
async function procesarRespuestaAbono(env, negocio, numeroCliente, texto, datos) {
  const c = clasificarRespuestaConfirmacion(texto);
  if (c === 'cancelar') return await descartarPago(env, negocio, numeroCliente, 'Listo, cancelé el abono. No registré nada.');
  if (c !== 'confirmar') {
    return await responderPago(env, negocio, numeroCliente,
      'Responde "sí" para registrar el abono o "no" para cancelarlo. Si algo está mal, di "no" y repítemelo con el nombre exacto.');
  }

  const db = env.oficina_ia_db;
  const reclamo = await db.prepare('DELETE FROM importaciones_pendientes WHERE negocio_id = ?').bind(negocio.id).run();
  if (reclamo.meta.changes !== 1) {
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, 'Ese abono ya se procesó, no lo sumé otra vez.');
    return Response.json({ ok: true, abono_ya_procesado: true });
  }

  let mensaje = 'Algo cambió en el cuadro (esa persona ya no está o hay más de una con ese nombre), así que no registré nada. Repíteme el abono y lo reviso de nuevo.';
  let registrado = false;
  try {
    const cuadro = await db.prepare('SELECT * FROM cuadros WHERE id = ? AND negocio_id = ?').bind(datos.cuadroId, negocio.id).first();
    if (cuadro) {
      const estructura = JSON.parse(cuadro.estructura);
      const filas = JSON.parse(cuadro.filas);
      const coincidentes = filas.filter(f => String(f?.nombre ?? '') === datos.nombreFila);
      const claveAbono = resolverClaveAbono(datos.campo, estructura.columnas, normalizarClave);
      if (coincidentes.length === 1 && claveAbono) {
        const resultado = await abonarEnCuadro(env, cuadro, estructura.columnas, filas, estructura.reglas_calculo || {},
          { tipo: 'exacto', fila: coincidentes[0] },
          { campo: datos.campo, valor: datos.valor, nombre: datos.nombreFila, _mensajeId: datos.mensajeId, _texto: '' },
          claveAbono, JSON.stringify(filas));
        mensaje = resultado.mensaje;
        registrado = resultado.tipo === 'ok';
      }
    }
  } catch (e) {
    console.log('[WEBHOOK] Error confirmando abono:', e?.message);
    mensaje = 'No pude registrar el abono. No cambié nada; inténtalo de nuevo en un momento.';
  }
  await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, mensaje);
  return Response.json({ ok: true, abono_confirmado: registrado });
}

// Abono de préstamo en un cuadro: suma al acumulado de la fila, recalcula el saldo con las reglas
// del cuadro y registra el hecho en `pagos` (tipo abono_prestamo). Cuadro + historial + pago van en
// UN batch atómico. El cuadro sigue siendo el dueño del saldo; `pagos` no calcula saldos de préstamos.
// Un reenvío del mismo mensaje de Meta choca con el índice único (negocio_id, mensaje_wa_id): el
// batch entero falla y no se suma dos veces.
async function abonarEnCuadro(env, cuadro, columnas, filas, reglas, busqueda, args, claveAbono, filasAntes) {
  if (esCorreccionDeAbono(args._texto)) {
    return {
      tipo: 'aviso',
      mensaje: textoRechazoCorreccionAbono(busqueda.fila.nombre),
      cerrarFlujo: true,
    };
  }
  const r = acumularAbono(busqueda.fila[claveAbono], args.valor);
  if (!r.ok) {
    return { tipo: 'aviso', mensaje: 'No entendí el monto del abono. Dime cuánto abonó, por ejemplo: "Yisel abonó 10".', cerrarFlujo: true };
  }

  const filaActualizada = calcularFila({ ...busqueda.fila, [claveAbono]: r.nuevo }, reglas);
  const filasNuevas = filas.map(f => (f === busqueda.fila ? filaActualizada : f));
  const nombre = busqueda.fila.nombre ?? filaActualizada.nombre ?? null;

  const insertarPago = env.oficina_ia_db.prepare(
    `INSERT INTO pagos (negocio_id, fecha, monto, tipo, documento_id, cuadro_id, referencia, concepto, origen, mensaje_wa_id)
     VALUES (?, ?, ?, 'abono_prestamo', NULL, ?, ?, ?, 'chat', ?)`
  ).bind(cuadro.negocio_id, fechaIsoPanama(), r.monto, cuadro.id, nombre, `Abono en "${cuadro.nombre_cuadro}"`, args._mensajeId || null);

  let historialId;
  try {
    historialId = await guardarCuadro(env, cuadro.id, filasNuevas, filasAntes, [insertarPago]);
  } catch (e) {
    if (/UNIQUE constraint/i.test(String(e?.message))) {
      console.log('[WEBHOOK] Abono repetido (mismo mensaje de WhatsApp), no se suma otra vez.');
      return { tipo: 'aviso', mensaje: 'Ese abono ya estaba registrado (el mensaje llegó repetido), así que no lo sumé otra vez.', cerrarFlujo: true };
    }
    console.log('[WEBHOOK] Error registrando abono:', e?.message);
    return { tipo: 'error', mensaje: 'No pude registrar el abono. No cambié nada; inténtalo de nuevo en un momento.', cerrarFlujo: true };
  }

  const aclaracion = busqueda.tipo === 'alto' ? ' (interpreté que te referías a esa persona)' : '';
  const lineas = [`Listo ✅ Registré el abono de ${formatoMonto(r.monto)} de ${nombre ?? 'esa persona'} en "${cuadro.nombre_cuadro}"${aclaracion}.`];
  if (args._notaCuadro) lineas.push(args._notaCuadro);
  lineas.push(`Lleva abonado ${formatoMonto(r.nuevo)} en total (antes ${formatoMonto(r.previo)}).`);
  const saldo = Number(filaActualizada.saldo);
  if (filaActualizada.saldo !== undefined && Number.isFinite(saldo)) {
    lineas.push(saldo < 0
      ? `Ojo: el saldo quedó en ${formatoMonto(saldo)} (negativo): el abono es mayor que lo que debía.`
      : `Saldo pendiente: ${formatoMonto(saldo)}.`);
  }
  return {
    tipo: 'ok',
    mensaje: lineas.join('\n'),
    fila: filaActualizada,
    historialId,
    cerrarFlujo: true,
    generarImagen: true,
    datosCuadro: { nombreCuadro: cuadro.nombre_cuadro, columnas, filas: filasNuevas },
  };
}

// Nunca borra directo — deja un "pendiente" en el negocio y pide
// confirmación explícita. El borrado real solo ocurre si el
// SIGUIENTE mensaje es exactamente "CONFIRMAR" (interceptado en
// onRequestPost antes de que Groq intervenga para nada).
async function pedirConfirmacionEliminarCuadro(env, negocio, cuadro, filas) {
  const pendiente = JSON.stringify({ cuadroId: cuadro.id, nombreCuadro: cuadro.nombre_cuadro });
  await env.oficina_ia_db.prepare(
    'UPDATE negocios SET confirmacion_pendiente = ? WHERE id = ?'
  ).bind(pendiente, negocio.id).run();

  return {
    tipo: 'aviso',
    mensaje: `⚠️ Vas a eliminar el cuadro "${cuadro.nombre_cuadro}" completo, con sus ${filas.length} registro(s). Esto no se puede deshacer.\n\nResponde *CONFIRMAR* para borrarlo, o cualquier otra cosa para cancelar.`,
  };
}

// Borra un cuadro y, si era una cotización/proforma indexada, deja su fila en
// `documentos` marcada 'anulada' (así no cuenta como "por cobrar"); una
// cotización ya 'convertida' conserva ese estado. Si el documento tiene pagos
// vigentes NO se borra: se devuelve { ok: false, motivo: 'pagos' }. Si el
// índice no se puede consultar por un error, no se arriesga: { ok: false,
// motivo: 'error' }. Las dos escrituras van en un solo batch (atómico).
async function eliminarCuadroConIndice(env, negocioId, cuadroId) {
  const db = env.oficina_ia_db;

  let doc = null;
  try {
    doc = await db.prepare(
      'SELECT id FROM documentos WHERE cuadro_id = ? AND negocio_id = ?'
    ).bind(cuadroId, negocioId).first();
  } catch (e) {
    // sin tabla documentos (aún no migrada) = no hay índice que mantener: se borra como antes
    console.log('[WEBHOOK] Índice de documentos no disponible al borrar cuadro:', e.message);
  }

  const sentencias = [];
  if (doc) {
    try {
      const p = await db.prepare(
        'SELECT COUNT(*) AS n FROM pagos WHERE documento_id = ? AND anulado = 0'
      ).bind(doc.id).first();
      if (p && p.n > 0) return { ok: false, motivo: 'pagos' };
    } catch (e) {
      console.log('[WEBHOOK] No pude verificar pagos al borrar cuadro:', e.message);
      return { ok: false, motivo: 'error' };
    }
    sentencias.push(
      db.prepare("UPDATE documentos SET estado = CASE WHEN estado = 'convertida' THEN estado ELSE 'anulada' END WHERE id = ?").bind(doc.id)
    );
  }
  // cuadros_historial referencia cuadros(id) SIN "ON DELETE": D1 hace cumplir las
  // llaves foráneas (probado en producción), así que un cuadro con historial NO se
  // podía borrar. Se borra su historial primero, solo si el cuadro es de este negocio.
  sentencias.push(db.prepare(
    'DELETE FROM cuadros_historial WHERE cuadro_id = ? AND cuadro_id IN (SELECT id FROM cuadros WHERE negocio_id = ?)'
  ).bind(cuadroId, negocioId));
  sentencias.push(db.prepare('DELETE FROM cuadros WHERE id = ? AND negocio_id = ?').bind(cuadroId, negocioId));
  await db.batch(sentencias);
  return { ok: true, anulado: !!doc };
}

async function eliminarFila(env, cuadro, columnas, filas, busqueda) {
  const filasAntes = JSON.stringify(filas);
  const filasNuevas = filas.filter(f => f !== busqueda.fila);
  const historialId = await guardarCuadro(env, cuadro.id, filasNuevas, filasAntes);

  return {
    tipo: 'ok',
    mensaje: `Eliminé a ${busqueda.fila.nombre} del cuadro.`,
    historialId,
    generarImagen: true,
    datosCuadro: { nombreCuadro: cuadro.nombre_cuadro, columnas, filas: filasNuevas },
  };
}

// UPDATE del cuadro + fila de historial (+ `sentenciasExtra`, ej. el pago de un abono) en UN batch
// atómico: o se guarda todo o nada. Devuelve el id de la fila de historial.
async function guardarCuadro(env, cuadroId, filas, filasAntesJson, sentenciasExtra = []) {
  const filasDespuesJson = JSON.stringify(filas);
  const db = env.oficina_ia_db;
  const resultados = await db.batch([
    db.prepare("UPDATE cuadros SET filas = ?, actualizado_en = datetime('now') WHERE id = ?").bind(filasDespuesJson, cuadroId),
    db.prepare('INSERT INTO cuadros_historial (cuadro_id, filas_antes, filas_despues) VALUES (?, ?, ?)').bind(cuadroId, filasAntesJson, filasDespuesJson),
    ...sentenciasExtra,
  ]);
  return resultados[1].meta.last_row_id;
}

async function obtenerCuadros(env, negocioId) {
  const { results } = await env.oficina_ia_db.prepare(
    'SELECT * FROM cuadros WHERE negocio_id = ?'
  ).bind(negocioId).all();
  return results;
}

function elegirCuadro(cuadros, nombreCuadroArg) {
  if (nombreCuadroArg) {
    const match = cuadros.find(c => (c.nombre_cuadro || '').toLowerCase() === nombreCuadroArg.toLowerCase());
    if (match) return match;
  }
  if (cuadros.length === 1) return cuadros[0];
  return null;
}

// Groq manda los valores como texto (ej. "10") — los que sean
// numéricos se convierten, para que calculo.js pueda operar con ellos.
function limpiarValor(v) {
  if (v === null || v === undefined || v === '') return v;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}

function limpiarValores(obj) {
  const limpio = {};
  for (const [k, v] of Object.entries(obj || {})) limpio[normalizarClave(k)] = limpiarValor(v);
  return limpio;
}

// Corrige las fórmulas de reglas_calculo para que usen las claves
// normalizadas de las columnas, sin importar cómo las haya escrito
// Groq (ej. "Deuda - Abono" → "deuda - abono"). Red de seguridad
// además de la instrucción que ya le damos en el system prompt.
function normalizarFormulasClaves(reglas, columnas) {
  const resultado = {};
  const columnasOrdenadas = [...(columnas || [])].sort((a, b) => b.length - a.length);

  for (const [campo, formula] of Object.entries(reglas || {})) {
    let formulaNormalizada = formula;
    for (const col of columnasOrdenadas) {
      const clave = normalizarClave(col);
      const escapado = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escapado}\\b`, 'gi');
      formulaNormalizada = formulaNormalizada.replace(regex, clave);
    }
    resultado[normalizarClave(campo)] = formulaNormalizada;
  }
  return resultado;
}

// ── HELPERS ─────────────────────────────────────────────────────

// ── ENLACES CORTOS ────────────────────────────────────────────
// Los enlaces de cobro (wa.me con el mensaje codificado en la URL)
// salen kilométricos. Se guarda el enlace real en D1 y se devuelve
// uno corto propio — sin depender de un acortador de terceros.

const DOMINIO_ENLACES_CORTOS = 'https://yesi-agente-ia.pages.dev';

function generarCodigoCorto(longitud = 7) {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(longitud));
  let codigo = '';
  for (let i = 0; i < longitud; i++) codigo += alfabeto[bytes[i] % alfabeto.length];
  return codigo;
}

// Guarda el enlace largo en D1 y devuelve el enlace corto. Si algo
// falla (ej. la tabla todavía no existe), devuelve el enlace largo
// original en vez de romper el envío del cobro.
async function acortarEnlace(env, urlLarga) {
  try {
    let codigo = generarCodigoCorto();
    // Reintenta si por pura mala suerte el código ya existe (ver
    // prueba: con 7 caracteres, 3.5 billones de combinaciones — la
    // probabilidad real es prácticamente cero, esto es solo una red
    // de seguridad barata).
    for (let intento = 0; intento < 5; intento++) {
      const yaExiste = await env.oficina_ia_db.prepare(
        'SELECT 1 FROM enlaces_cortos WHERE codigo = ?'
      ).bind(codigo).first();
      if (!yaExiste) break;
      codigo = generarCodigoCorto();
    }
    await env.oficina_ia_db.prepare(
      'INSERT INTO enlaces_cortos (codigo, url_destino) VALUES (?, ?)'
    ).bind(codigo, urlLarga).run();
    return `${DOMINIO_ENLACES_CORTOS}/c/${codigo}`;
  } catch (e) {
    console.log('[WEBHOOK] Error acortando enlace, se usa el largo:', e.message);
    return urlLarga;
  }
}

function normalizarClave(texto) {
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '') // quita paréntesis, %, etc. — ej. "interes (10%)" -> "interes 10"
    .trim()
    .replace(/\s+/g, '_'); // "abono a capital" -> "abono_a_capital" — expr-eval no acepta espacios en un nombre de variable
}

// Cómo se redacta el "campo libre" de una carta (el ÚLTIMO campo requerido de
// cada plantilla, ej. "motivo" o "gestion"). Ese texto se inserta DESPUÉS de
// una frase introductoria del documento ("solicito ... lo siguiente:",
// "realice la siguiente gestión:"), que ya trae el verbo. Copiar las palabras
// del usuario tal cual producía frases como "solicito lo siguiente: Solicitar
// permiso..." o "la siguiente gestión: Retirarme un paquete...".
const REGLA_CAMPO_LIBRE =
  'El texto del campo libre debe ser una frase nominal que EMPIECE CON UN SUSTANTIVO ' +
  '(ej. "Permiso para realizar una remodelación el viernes", "El retiro de un paquete en la oficina de encomiendas"), ' +
  'NUNCA con un verbo en infinitivo ni en primera persona (no "Solicitar…", "Retirarme…", "Quiero…"), porque el ' +
  'documento ya trae el verbo justo antes. Copia EXACTOS los nombres, fechas, horas, lugares, números y cantidades ' +
  'que dio el usuario: solo cambia la forma de la frase, nunca los datos, y no agregues nada que no dijo.';

function construirSystemPrompt(negocio, cuadros, cartasDisponibles = [], conPagos = false, conAjustes = false) {
  let prompt = `Eres el asistente de Oficina IA para el negocio "${negocio.nombre}".\n`;

  if (negocio.contexto_negocio) {
    prompt += `\nContexto del negocio:\n${negocio.contexto_negocio}\n`;
  }

  const describirColumnas = (estructuraJson) => {
    const columnas = JSON.parse(estructuraJson || '{}').columnas || [];
    if (columnas.length === 0) return '';
    return columnas.map(col => `"${col}" (clave: "${normalizarClave(col)}")`).join(', ');
  };
  const esSeccionesEstructura = (estructuraJson) => JSON.parse(estructuraJson || '{}').tipo === 'secciones';
  const AVISO_SOLO_LECTURA = 'reporte de SOLO LECTURA (viene de una foto) — usa consultar_cuadro o enviar_excel; NUNCA agregar_fila/actualizar_fila/eliminar_fila con este';

  if (cuadros.length === 0) {
    prompt += `\nEste negocio todavía NO tiene ningún cuadro creado — si el usuario pide registrar algo, usa crear_cuadro primero.\n`;
  } else if (cuadros.length === 1) {
    prompt += `\nEste negocio tiene un solo cuadro: "${cuadros[0].nombre_cuadro}". No hace falta que menciones nombre_cuadro.\n`;
    if (esSeccionesEstructura(cuadros[0].estructura)) {
      prompt += `Es un ${AVISO_SOLO_LECTURA}.\n`;
    } else {
      const columnasDesc = describirColumnas(cuadros[0].estructura);
      if (columnasDesc) prompt += `Columnas de este cuadro: ${columnasDesc}.\n`;
    }
  } else {
    prompt += `\nEste negocio tiene varios cuadros: ${cuadros.map(c => c.nombre_cuadro).join(', ')}. Identifica a cuál se refiere el usuario y menciona nombre_cuadro.\n`;
    for (const c of cuadros) {
      if (esSeccionesEstructura(c.estructura)) {
        prompt += `- "${c.nombre_cuadro}": ${AVISO_SOLO_LECTURA}.\n`;
      } else {
        const columnasDesc = describirColumnas(c.estructura);
        if (columnasDesc) prompt += `- "${c.nombre_cuadro}": ${columnasDesc}\n`;
      }
    }
  }

  if (cartasDisponibles.length > 0) {
    const describirCampos = (campos) => campos.map(c => `"${c.id}" (${c.etiqueta})`).join(', ');
    prompt += `\nCartas/documentos disponibles (usa el "id" EXACTO en tipo_carta de generar_carta):\n`;
    for (const p of cartasDisponibles) {
      prompt += `- "${p.id}" — ${p.nombre}: campos requeridos [${describirCampos(p.camposRequeridos)}]`;
      if (p.camposOpcionales.length > 0) prompt += `, opcionales [${describirCampos(p.camposOpcionales)}]`;
      prompt += `\n`;
    }
  }

  prompt += `
Reglas OBLIGATORIAS:
- NUNCA calcules montos, interés ni saldos tú mismo — solo extrae los valores crudos que el usuario mencionó.
- NUNCA decidas a quién corresponde un nombre parecido o mal escrito — extrae el nombre TAL CUAL lo dijo el usuario.
- Si el usuario solo pregunta/consulta sin pedir un cambio, usa consultar_cuadro, nunca una herramienta de escritura.
- Si el usuario pide el PDF de un cuadro, cotización o factura proforma, usa enviar_pdf (NO enviar_excel ni generar_carta).
- Si el usuario pide el Excel, la hoja de cálculo o el archivo del cuadro, usa enviar_excel (con_imagen=true solo si además pide la imagen). Si pide ver el cuadro o la imagen, usa consultar_cuadro.
- NUNCA inventes un número de teléfono — el parámetro "telefono" solo se llena si el usuario lo dio explícitamente en este mensaje o en uno reciente de la conversación.
- En agregar_fila y actualizar_fila, usa EXACTAMENTE la "clave" indicada arriba para cada columna — NUNCA inventes un nombre de campo nuevo. Ejemplo: si la columna es "Monto" (clave "monto") y el usuario dice "préstamo de 200" o "capital de 200", igual usa la clave "monto", no "prestamo" ni "capital".
- En crear_cuadro, las fórmulas de reglas_calculo deben referirse a las columnas usando su clave en minúsculas y sin tildes (ej. columna "Deuda" → escribe "deuda" en la fórmula, no "Deuda").
- Si el usuario pide una COTIZACIÓN o presupuesto (ej. "hazme una cotización para Juan, 10 sillas a 25"), usa crear_cotizacion: una entrada en "lineas" por producto o servicio, con descripcion, cantidad y precio UNITARIO tal cual los dijo. NUNCA calcules totales, subtotal ni ITBMS. El campo itbms de una línea se llena SOLO si el usuario dijo una tasa para esa línea (ej. "10%", "exento"); si no la dijo, OMÍTELO (el sistema aplica 7%) y NUNCA la deduzcas por el tipo de producto. Si dijo "todo exento" o "todo al 10%", repítelo en cada línea. NO uses crear_cuadro ni generar_carta para una cotización.
- Si el usuario pide una FACTURA, una factura proforma o una nota de cobro para un cliente (ej. "hazme una factura para Juan, 10 sillas a 25"), usa crear_factura_proforma (este sistema no emite facturas fiscales; todo pedido de factura se resuelve así). Las mismas reglas de crear_cotizacion: "lineas" con descripcion, cantidad y precio UNITARIO tal cual los dijo; NUNCA calcules totales, subtotal ni ITBMS; "itbms" de una línea SOLO si el usuario dijo una tasa; "condicion_pago" SOLO si la dijo. NO uses crear_cuadro ni generar_carta para una factura.
- Si el usuario pide pasar, convertir o hacer la factura (o factura proforma / nota de cobro) DE UNA COTIZACIÓN QUE YA EXISTE (ej. "hazme la factura de la cotización 004", "pasa la cotización de Juan a factura"), usa convertir_cotizacion_en_factura con nombre_cuadro = la cotización tal cual la dijo ("la última" si dijo así, o null si no dijo cuál). NO uses crear_factura_proforma para eso: esa es para una factura desde cero con productos que dicta ahora.
- En generar_carta, usa EXACTAMENTE los "id" de campo listados arriba para esa plantilla como claves de "campos" — nunca inventes un id nuevo. Si el usuario no dio un dato, simplemente omítelo del objeto "campos", no lo dejes en blanco ni lo completes tú.
- En generar_carta, el ÚLTIMO campo requerido de cada plantilla es su campo libre (ej. "motivo", "gestion"). ${REGLA_CAMPO_LIBRE} Esta regla tiene prioridad sobre "tal cual lo dijo" SOLO para ese último campo; todos los demás campos van tal cual.
`.trim();

  // Regla de pagos: solo si el negocio ya tiene facturas proforma (la herramienta registrar_pago
  // solo se ofrece entonces). Así un negocio de préstamos no la ve nunca.
  const reglaPagos = conPagos
    ? `\n- Si el usuario dice que un cliente PAGÓ, ABONÓ o CANCELÓ algo de una FACTURA (ej. "Juan pagó 100", "Ana abonó 50 de la factura 004", "Juan pagó 100 ayer"), usa registrar_pago con el cliente, el monto y, SOLO si los dijo, el número de factura y la fecha, tal cual. NUNCA calcules saldos ni decidas a qué factura va: el sistema lo hace y le pregunta al usuario. NO uses registrar_pago para abonos de un cuadro de préstamos ni de ningún otro cuadro: eso sigue siendo actualizar_fila.`
    : '';
  const reglaAjustes = conAjustes
    ? `\n- Si el usuario pide ANULAR o DESHACER un PAGO (ej. "anula el pago de Ana", "me equivoqué con el pago de Juan"), ANULAR una factura o cotización (ej. "anula la factura 004") o APLICAR un saldo a favor a una factura (ej. "aplica el saldo a favor de Ana a la factura 004"), usa ajustar_pago con la accion que corresponda y los datos tal cual los dijo. NUNCA calcules ni decidas cuál pago o factura es: el sistema pregunta y pide confirmación. "Anular" NO es "eliminar el cuadro" (eso sigue siendo eliminar_cuadro).`
    : '';
  return `${prompt}${reglaPagos}${reglaAjustes}`;
}

// ── IMPORTAR UN CUADRO DESDE UNA FOTO ─────────────────────────────
// Flujo completo: descargar la foto -> Groq la transcribe (nunca
// calcula) -> detectorFormulas.js decide las fórmulas en JavaScript
// puro -> se valida contra la fila "Total" de la foto, si la trae ->
// se guarda como PENDIENTE (nunca se crea el cuadro de una vez) ->
// se manda la imagen de cómo quedó + un texto para confirmar.

async function procesarFotoCuadro(env, negocio, numeroCliente, mensajeEntrante) {
  const mediaId = mensajeEntrante.image?.id;

  let bytes, mimeType;
  try {
    ({ bytes, mimeType } = await descargarImagenWhatsApp(mediaId, negocio.wa_token));
  } catch (e) {
    console.log('[WEBHOOK] Error descargando la foto:', e.message);
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
      'No pude descargar esa foto. ¿Puedes mandarla de nuevo?');
    return Response.json({ ok: true, info: 'error descargando foto' });
  }

  let extraido;
  try {
    extraido = await analizarFotoCuadro(bytes, mimeType, env.GROQ_API_KEY_PRO || env.GROQ_API_KEY);
  } catch (e) {
    console.log('[WEBHOOK] Error leyendo la foto con Groq:', e.message);
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
      e.esLimiteDeUso
        ? 'Estoy con mucho trabajo en este momento y no pude procesar tu foto. Vuelve a mandarla en un minuto.'
        : 'No pude leer bien esa foto. Intenta con buena luz y sin recortar los bordes de la tabla.');
    return Response.json({ ok: true, info: 'error de visión' });
  }

  // Reporte tipo "secciones" (ej. Pago de Quincena) — flujo aparte:
  // no pasa por detectorFormulas.js (no hay patrón entre filas que
  // detectar, cada sección es un solo registro), sino por
  // reporteSecciones.js, que verifica cada fórmula que Groq sugirió
  // contra el valor real de la foto antes de aceptarla.
  if (extraido.tipo === 'secciones') {
    let datosSecciones;
    try {
      datosSecciones = construirDatosImportacionSecciones(extraido);
    } catch (e) {
      console.log('[WEBHOOK] Error validando el reporte por secciones:', e.message);
      await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
        'No pude interpretar bien ese reporte. Intenta con buena luz y sin recortar los bordes.');
      return Response.json({ ok: true, info: 'error validando reporte por secciones' });
    }

    await env.oficina_ia_db.prepare(
      `INSERT INTO importaciones_pendientes (negocio_id, datos) VALUES (?, ?)
       ON CONFLICT(negocio_id) DO UPDATE SET datos = excluded.datos, creado_en = datetime('now')`
    ).bind(negocio.id, JSON.stringify(datosSecciones)).run();

    await enviarVistaPreviaReporteSecciones(env, negocio, numeroCliente, datosSecciones);
    return Response.json({ ok: true, negocio: negocio.slug, importacion_pendiente: true, tipo: 'secciones' });
  }

  const datos = construirDatosImportacion(extraido);

  await env.oficina_ia_db.prepare(
    `INSERT INTO importaciones_pendientes (negocio_id, datos) VALUES (?, ?)
     ON CONFLICT(negocio_id) DO UPDATE SET datos = excluded.datos, creado_en = datetime('now')`
  ).bind(negocio.id, JSON.stringify(datos)).run();

  await enviarVistaPreviaImportacion(env, negocio, numeroCliente, datos);
  return Response.json({ ok: true, negocio: negocio.slug, importacion_pendiente: true, validacion: datos.validacion });
}

// A partir de lo que transcribió Groq para un reporte tipo "secciones",
// arma el objeto que se guarda como pendiente: reusa exactamente
// validarReporteSecciones() (ya probado con los datos reales de
// Eduardo) y le agrega "tipo"/"nombreCuadro" para que el resto del
// archivo (procesarRespuestaImportacion, confirmarImportacion...)
// pueda distinguirlo de un cuadro de tabla uniforme.
function construirDatosImportacionSecciones(extraido) {
  const validado = validarReporteSecciones(extraido);
  return {
    tipo: 'secciones',
    nombreCuadro: validado.titulo || 'Reporte importado',
    ...validado,
  };
}

// A partir de lo que transcribió Groq, arma el objeto que se guarda
// como pendiente: claves internas normalizadas, valores tipados, y
// las fórmulas + validación que decide detectorFormulas.js (nunca Groq).
function construirDatosImportacion(extraido) {
  const columnasBonitas = extraido.columnas;
  const columnasInternas = columnasBonitas.map(normalizarClave);

  const filas = extraido.filas.map(filaCruda => {
    const f = {};
    columnasBonitas.forEach((bonita, i) => { f[columnasInternas[i]] = parsearValorFoto(filaCruda[bonita]); });
    return f;
  });

  let filaTotales = null;
  if (extraido.filaTotales) {
    filaTotales = {};
    columnasBonitas.forEach((bonita, i) => {
      if (extraido.filaTotales[bonita] !== undefined) {
        filaTotales[columnasInternas[i]] = parsearValorFoto(extraido.filaTotales[bonita]);
      }
    });
  }

  const reglasCrudas = detectarFormulas(columnasInternas, filas);
  const reglas = Object.fromEntries(Object.entries(reglasCrudas).map(([k, v]) => [k, v.formula]));
  const validacion = validarContraTotales(columnasInternas, filas, filaTotales);

  // ENCABEZADO y PIE (facturas): opcionales, [] si la imagen no los trae
  // — en ese caso todo lo de abajo se comporta exactamente como antes.
  // Un campo sin lectura segura queda pendiente (avisosEncabezado/
  // alertas del pie), nunca inventado.
  const encabezado = validarEncabezado(extraido.encabezado);
  const { pie, alertas: alertasPie } = validarPie(extraido.pie, columnasInternas, filas);
  const avisosPendientes = [...avisosEncabezado(encabezado), ...alertasPie];

  return {
    nombreCuadro: extraido.titulo || 'Cuadro importado',
    subtitulo: extraido.subtitulo || null,
    columnasBonitas,
    columnasInternas,
    filas,
    filaTotales,
    reglas,
    validacion,
    encabezado,
    pie,
    avisosPendientes,
  };
}

// Convierte un valor tal como lo transcribió Groq (puede venir como
// texto "360.00", número, o vacío) a lo que calculo.js espera: número
// si se puede, texto si no, 0 si viene vacío/nulo. Los valores en
// blanco siempre se transcriben como 0 (nunca se inventa un número).
function parsearValorFoto(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const texto = String(v).trim();
  if (texto === '') return 0;
  const limpio = texto.replace(/[$,\s]/g, '');
  if (/^-?\d+(\.\d+)?$/.test(limpio)) return Number(limpio);
  return texto;
}

// Manda la imagen de cómo quedó el cuadro + el texto para confirmar,
// corregir o cancelar. Se usa tanto la primera vez como después de
// cada corrección (el ciclo se repite hasta que el usuario confirma).
async function enviarVistaPreviaImportacion(env, negocio, numeroCliente, datos) {
  let pngBytes = null;
  try {
    pngBytes = await generarImagenCuadro(
      datos.nombreCuadro, datos.columnasBonitas, datos.filas, datos.subtitulo, true,
      { encabezado: datos.encabezado, pie: datos.pie }
    );
  } catch (e) {
    console.log('[WEBHOOK] Error generando la vista previa:', e.message);
  }

  if (pngBytes) {
    const resImg = await enviarImagenCuadroDirecta(negocio, numeroCliente, pngBytes, datos.origen === 'texto' ? datos.nombreCuadro : 'Así leí tu cuadro:');
    console.log('[WEBHOOK] Respuesta de Meta al enviar la vista previa:', JSON.stringify(resImg));
  }

  const texto = construirTextoConfirmacion(datos);
  const resTxt = await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, texto);
  console.log('[WEBHOOK] Respuesta de Meta al enviar el texto de confirmación:', JSON.stringify(resTxt));
}

function construirTextoConfirmacion(datos) {
  // ENCABEZADO del documento (facturas) — se lista antes que las líneas.
  const lineasEncabezado = (datos.encabezado || []).map(c => `${c.etiqueta}: ${c.valor ?? '(sin identificar)'}`);

  const lineas = datos.filas.map(f => {
    const partes = datos.columnasInternas.slice(1).map(c => {
      const bonita = datos.columnasBonitas[datos.columnasInternas.indexOf(c)];
      return `${bonita} ${f[c]}`;
    });
    const nombre = f[datos.columnasInternas[0]];
    return `${nombre}: ${partes.join(', ')}`;
  });

  // PIE (Subtotal → ITBMS → Total, facturas) — después de las líneas.
  const lineasPie = (datos.pie || []).map(f => `${f.etiqueta}: ${f.valor ?? '(sin identificar)'}`);

  let resumenValidacion;
  if (!datos.validacion.tieneFilaTotales) {
    resumenValidacion = '';
  } else if (datos.validacion.coincide) {
    resumenValidacion = '\n\n✅ El Total de la foto coincide con lo que leí.';
  } else {
    const detalle = datos.validacion.detalles
      .map(d => {
        const bonita = datos.columnasBonitas[datos.columnasInternas.indexOf(d.columna)];
        return `${bonita}: tu foto dice ${d.totalFoto}, yo sumé ${d.sumaCalculada}`;
      })
      .join('\n');
    resumenValidacion = `\n\n⚠️ El Total no coincide con lo que leí:\n${detalle}\nRevisa esos datos arriba y dime cuál está mal.`;
  }

  // Campos que no se leyeron con seguridad (encabezado o pie) — se avisa,
  // nunca se bloquea: el cuadro se puede crear igual y completarlos después.
  const avisoPendientes = (datos.avisosPendientes || []).length > 0
    ? `\n\n⚠️ ${(datos.avisosPendientes || []).join('\n⚠️ ')}`
    : '';

  const bloqueEncabezado = lineasEncabezado.length > 0 ? `${lineasEncabezado.join('\n')}\n\n` : '';
  const bloquePie = lineasPie.length > 0 ? `\n\n${lineasPie.join('\n')}` : '';

  return `${datos.origen === 'texto' ? `Así quedó tu ${nombreDocumento(datos)}:` : 'Aquí está el cuadro que leí de tu foto:'}\n\n${bloqueEncabezado}${lineas.join('\n')}${bloquePie}${resumenValidacion}${avisoPendientes}\n\n¿Está bien así? Responde "sí" para crear ${datos.origen === 'texto' ? `la ${nombreDocumento(datos)}` : 'el cuadro'}, "no" para descartar${datos.origen === 'texto' ? 'la' : 'lo'}, o dime qué corregir${datos.origen === 'texto' ? ' (ej. "el cliente es Juan Pérez", "las sillas son 12", "agrega 3 mesas a 80", "quita las sillas")' : ''}.`;
}

// Misma idea que enviarVistaPreviaImportacion, pero para un reporte
// tipo "secciones" — reusa enviarImagenCuadroDirecta tal cual (esa
// función no le importa qué representan los bytes del PNG).
async function enviarVistaPreviaReporteSecciones(env, negocio, numeroCliente, datos) {
  let pngBytes = null;
  try {
    pngBytes = await generarImagenReporteSecciones(datos);
  } catch (e) {
    console.log('[WEBHOOK] Error generando la vista previa del reporte por secciones:', e.message);
  }

  if (pngBytes) {
    const resImg = await enviarImagenCuadroDirecta(negocio, numeroCliente, pngBytes, 'Así leí tu reporte:');
    console.log('[WEBHOOK] Respuesta de Meta al enviar la vista previa (secciones):', JSON.stringify(resImg));
  }

  const texto = construirTextoConfirmacionSecciones(datos);
  const resTxt = await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, texto);
  console.log('[WEBHOOK] Respuesta de Meta al enviar el texto de confirmación (secciones):', JSON.stringify(resTxt));
}

// Alcance de esta primera versión: SOLO se puede confirmar o
// descartar, no corregir campo por campo (ver aviso al final del
// texto) — eso es una decisión de diseño ya acordada, no un hueco.
function construirTextoConfirmacionSecciones(datos) {
  const lineasEstadisticas = (datos.estadisticas || []).map(e => `${e.etiqueta}: ${e.valor}`);
  const bloques = (datos.secciones || []).map(seccion => {
    const lineas = seccion.filas.map(f => `  ${f.etiqueta}: ${f.valor}`).join('\n');
    return `${seccion.nombre}\n${lineas}`;
  });

  const partes = [...lineasEstadisticas, ...bloques].filter(Boolean);

  return `Así leí tu reporte:\n\n${partes.join('\n\n')}\n\n¿Está bien así? Responde "sí" para crear el reporte, o "no" para descartarlo.\n\n(Por ahora este tipo de reporte no se corrige campo por campo por chat — si algo está mal, responde "no" y mándame la foto de nuevo con mejor luz o encuadre.)`;
}

// Sube el PNG a Meta (/media) y lo manda como mensaje de imagen — el
// mismo patrón que enviarExcelCuadro ya usa para el .xlsx, sin
// depender de Cloudinary.
async function enviarImagenCuadroDirecta(negocio, to, pngBytes, captionCorta) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'image/png');
  form.append('file', new Blob([pngBytes], { type: 'image/png' }), 'cuadro.png');

  const subida = await fetch(`https://graph.facebook.com/v21.0/${negocio.phone_number_id}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${negocio.wa_token}` },
    body: form,
  });
  const subidaData = await subida.json();
  if (!subidaData.id) {
    console.log('[WEBHOOK] Error subiendo la vista previa a Meta:', JSON.stringify(subidaData));
    return subidaData;
  }

  const res = await fetch(`https://graph.facebook.com/v21.0/${negocio.phone_number_id}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${negocio.wa_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      ...destinatarioWhatsApp(to),
      type: 'image',
      image: { id: subidaData.id, caption: (captionCorta || '').slice(0, 1000) },
    }),
  });
  return res.json();
}

// ── RESPUESTA A LA IMPORTACIÓN PENDIENTE (sí / no / corrección) ──
async function procesarRespuestaImportacion(env, negocio, numeroCliente, texto, importacionPendiente) {
  const datos = JSON.parse(importacionPendiente.datos);
  // Un pago esperando elección o confirmación NO es un documento: su propia lógica (fase 1b-2).
  if (datos.tipoPendiente === 'pago') {
    const respuesta = await procesarRespuestaPago(env, negocio, numeroCliente, texto, datos);
    await marcarFlujoPagoCerrado(env, negocio.id);
    return respuesta;
  }
  if (datos.tipoPendiente === 'pago_ajuste') {
    const respuesta = await procesarRespuestaAjuste(env, negocio, numeroCliente, texto, datos);
    await marcarFlujoPagoCerrado(env, negocio.id);
    return respuesta;
  }
  if (datos.tipoPendiente === 'abono') {
    const respuesta = await procesarRespuestaAbono(env, negocio, numeroCliente, texto, datos);
    await marcarFlujoPagoCerrado(env, negocio.id);
    return respuesta;
  }
  // normalizarClave ya quita tildes/mayúsculas — más confiable que una
  // expresión regular con \b, que en JavaScript NO reconoce como letra
  // un carácter acentuado: /^s[ií]\b/ nunca hace match con "sí" escrito
  // normal, solo con "si" sin tilde. Comparamos por PALABRA, no por texto
  // completo, para no confundir una corrección que empiece parecido
  // (ej. "no se ve bien el monto de Susan" sigue siendo una corrección).
  const respuesta = clasificarRespuestaPendiente(texto);
  const esSecciones = datos.tipo === 'secciones';

  if (respuesta === 'confirmar') {
    return esSecciones
      ? await confirmarImportacionSecciones(env, negocio, numeroCliente, datos)
      : await confirmarImportacion(env, negocio, numeroCliente, datos);
  }

  if (respuesta === 'descartar') {
    await env.oficina_ia_db.prepare('DELETE FROM importaciones_pendientes WHERE negocio_id = ?').bind(negocio.id).run();
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
      esSecciones ? 'Reporte descartado. Mándame la foto de nuevo cuando quieras.'
        : datos.origen === 'texto' ? `${nombreDocumento(datos) === 'cotización' ? 'Cotización descartada' : 'Factura proforma descartada'}. Cuando quieras, dime de nuevo qué lleva.`
        : 'Cuadro descartado. Mándame la foto de nuevo cuando quieras.');
    return Response.json({ ok: true, importacion_cancelada: true });
  }

  // Los reportes de secciones todavía no se corrigen campo por campo
  // por chat (decisión de alcance ya acordada) — se deja el pendiente
  // intacto para que el usuario pueda decidir "sí" o "no" después.
  if (esSecciones) {
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
      'Por ahora este tipo de reporte no se corrige campo por campo por chat. Responde "sí" para crear el reporte tal como te lo mandé, o "no" para descartarlo y mandarme la foto de nuevo.');
    return Response.json({ ok: true, correccion_no_soportada_secciones: true });
  }

  // Documentos con encabezado o pie (cotizaciones, facturas leídas de foto):
  // se puede corregir el cliente, la fecha y demás datos del encabezado, y
  // las líneas por descripción (o número).
  if ((datos.encabezado || []).length > 0 || (datos.pie || []).length > 0) {
    return await corregirDocumentoPendiente(env, negocio, numeroCliente, texto, datos);
  }

  // Cualquier otra cosa se interpreta como una corrección puntual —
  // igual que con un cuadro ya creado: Groq solo EXTRAE a qué
  // registro/columna/valor se refiere, nunca calcula nada.
  let correccion;
  try {
    correccion = await interpretarCorreccion(texto, datos.columnasBonitas, env.GROQ_API_KEY);
  } catch (e) {
    console.log('[WEBHOOK] Error interpretando corrección:', e.message);
    correccion = null;
  }

  if (!correccion || !correccion.nombre || !correccion.campo) {
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
      'No entendí bien esa corrección. ¿Puedes decirlo así: "el [columna] de [nombre] es [valor]"?');
    return Response.json({ ok: true, correccion_no_entendida: true });
  }

  const campoInterno = normalizarClave(correccion.campo);
  if (!datos.columnasInternas.includes(campoInterno)) {
    const nombresColumnas = datos.columnasBonitas.join(', ');
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
      `No reconozco la columna "${correccion.campo}". Las columnas de este cuadro son: ${nombresColumnas}.`);
    return Response.json({ ok: true, correccion_columna_desconocida: true });
  }

  const claveNombre = datos.columnasInternas[0];
  const nombreBuscado = normalizarClave(correccion.nombre);
  const indiceFila = datos.filas.findIndex(f => normalizarClave(String(f[claveNombre])) === nombreBuscado);
  if (indiceFila === -1) {
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
      `No encontré a "${correccion.nombre}" en el cuadro que te mandé. Revisa el nombre y vuelve a intentar.`);
    return Response.json({ ok: true, correccion_nombre_no_encontrado: true });
  }

  datos.filas[indiceFila][campoInterno] = parsearValorFoto(correccion.valor);

  // Si el campo corregido es uno de los datos crudos (ej. Monto), se
  // recalculan los campos que dependen de él. Si el campo corregido
  // es uno de los ya calculados (ej. Saldo), se respeta tal cual el
  // usuario lo dijo — no se vuelve a pisar con la fórmula.
  const reglasSinCampoCorregido = { ...datos.reglas };
  delete reglasSinCampoCorregido[campoInterno];
  datos.filas[indiceFila] = calcularFila(datos.filas[indiceFila], reglasSinCampoCorregido);

  datos.validacion = validarContraTotales(datos.columnasInternas, datos.filas, datos.filaTotales);
  if ((datos.pie || []).length > 0) datos.pie = recalcularPie(datos.pie, datos.columnasInternas, datos.filas);

  await env.oficina_ia_db.prepare(
    "UPDATE importaciones_pendientes SET datos = ?, creado_en = datetime('now') WHERE negocio_id = ?"
  ).bind(JSON.stringify(datos), negocio.id).run();

  await enviarVistaPreviaImportacion(env, negocio, numeroCliente, datos);
  return Response.json({ ok: true, correccion_aplicada: true });
}

async function confirmarImportacion(env, negocio, numeroCliente, datos) {
  const cuadrosExistentes = await obtenerCuadros(env, negocio.id);
  const nombreNormalizado = normalizarClave(datos.nombreCuadro);
  const yaExiste = cuadrosExistentes.find(c => normalizarClave(c.nombre_cuadro) === nombreNormalizado);
  const nombreFinal = yaExiste ? `${datos.nombreCuadro} (importado)` : datos.nombreCuadro;

  const estructura = JSON.stringify({
    columnas: datos.columnasBonitas,
    reglas_calculo: datos.reglas,
    subtitulo: datos.subtitulo || undefined,
    encabezado: (datos.encabezado || []).length > 0 ? datos.encabezado : undefined,
    pie: (datos.pie || []).length > 0 ? datos.pie : undefined,
  });

  const insertCuadro = await env.oficina_ia_db.prepare(
    'INSERT INTO cuadros (negocio_id, nombre_cuadro, estructura, filas) VALUES (?, ?, ?, ?)'
  ).bind(negocio.id, nombreFinal, estructura, JSON.stringify(datos.filas)).run();

  // Índice comercial (tabla documentos): solo cotizaciones/proformas armadas por
  // el bot (traen tipoDocumento; las facturas leídas de foto no). Si falla, el
  // documento ya quedó guardado: se registra el error y se sigue.
  if (datos.tipoDocumento) {
    await registrarDocumentoEnIndice(env, negocio.id, insertCuadro.meta.last_row_id, nombreFinal, JSON.parse(estructura), datos.tipoDocumento);
  }

  await env.oficina_ia_db.prepare('DELETE FROM importaciones_pendientes WHERE negocio_id = ?').bind(negocio.id).run();

  const aviso = yaExiste
    ? ` (ya tenías un cuadro llamado "${datos.nombreCuadro}", así que a este le puse "${nombreFinal}")`
    : '';
  await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
    `Listo, creé el cuadro "${nombreFinal}"${aviso} ✅. Ya puedes pedirme la imagen o el Excel cuando quieras.`);

  return Response.json({ ok: true, cuadro_creado: nombreFinal });
}

// Registra una cotización/proforma recién guardada en la tabla `documentos`
// (índice de solo agregar; ver migracion_1a_documentos.sql). Nunca lanza: un
// fallo aquí no debe deshacer ni ocultar el documento ya guardado. Si es una
// proforma hecha desde una cotización, enlaza con ella y la marca 'convertida'
// (las dos escrituras van en un solo batch: o entran las dos o ninguna).
async function registrarDocumentoEnIndice(env, negocioId, cuadroId, nombreCuadro, estructura, tipo) {
  try {
    const f = filaIndiceDocumento({ nombreCuadro, estructura, tipo });
    if (!f) {
      console.log('[WEBHOOK] Documento sin fila de índice (nombre/tipo no reconocido):', nombreCuadro);
      return;
    }
    const db = env.oficina_ia_db;
    const sentencias = [
      db.prepare(
        `INSERT INTO documentos (negocio_id, cuadro_id, tipo, numero, cliente, fecha, subtotal, itbms, total, revisar, referencia_doc_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           (SELECT id FROM documentos WHERE negocio_id = ? AND tipo = 'cotizacion' AND numero = ? AND cuadro_id IS NOT NULL ORDER BY id DESC LIMIT 1))`
      ).bind(negocioId, cuadroId, f.tipo, f.numero, f.cliente, f.fecha, f.subtotal, f.itbms, f.total, f.revisar, negocioId, f.referenciaNumero),
    ];
    if (f.referenciaNumero) {
      sentencias.push(
        db.prepare(
          `UPDATE documentos SET estado = 'convertida'
           WHERE estado = 'emitida' AND id = (SELECT referencia_doc_id FROM documentos WHERE cuadro_id = ?)`
        ).bind(cuadroId)
      );
    }
    await db.batch(sentencias);
  } catch (e) {
    console.log('[WEBHOOK] Error registrando en documentos:', nombreCuadro, e.message);
  }
}

// ── PAGOS (fase 1b-2) ─────────────────────────────────────────────
// Groq solo extrae cliente / monto / número de factura / fecha, tal cual. TODO lo
// demás lo decide este código: a qué factura va, el saldo, el reparto. Nada se
// guarda sin vista previa con el efecto y un "sí" explícito. Mientras hay un pago
// esperando, vive en importaciones_pendientes con tipoPendiente = 'pago'.

async function negocioTieneProformas(env, negocioId) {
  try {
    const f = await env.oficina_ia_db.prepare(
      "SELECT 1 AS hay FROM documentos WHERE negocio_id = ? AND tipo = 'proforma' AND estado != 'anulada' LIMIT 1"
    ).bind(negocioId).first();
    return !!f;
  } catch (e) {
    console.log('[WEBHOOK] No pude consultar las proformas del negocio:', e.message);
    return false;
  }
}

// Proformas vigentes con su saldo (total − pagos no anulados). El saldo se DERIVA, nunca se guarda.
async function cargarProformasConSaldo(env, negocioId) {
  const db = env.oficina_ia_db;
  const { results: docs } = await db.prepare(
    "SELECT id, numero, cliente, fecha, total FROM documentos WHERE negocio_id = ? AND tipo = 'proforma' AND estado != 'anulada' AND total IS NOT NULL"
  ).bind(negocioId).all();
  const { results: pagos } = await db.prepare(
    'SELECT documento_id, monto FROM pagos WHERE negocio_id = ? AND anulado = 0 AND documento_id IS NOT NULL'
  ).bind(negocioId).all();
  const saldos = calcularSaldos(docs, pagos);
  return docs.map(d => ({ ...d, saldo: saldos.get(d.id) }));
}

// "¿Quién me debe?": préstamos de los cuadros + proformas por cobrar (saldo derivado) + saldo a favor.
// Reutiliza las mismas fuentes que el registro de pagos, así hay una sola verdad por cifra.
async function armarReporteDeudasNegocio(env, negocio, consulta) {
  const cuadros = await obtenerCuadros(env, negocio.id);
  const prestamos = extraerPrestamosDeCuadros(cuadros, normalizarClave);
  const proformas = await cargarProformasConSaldo(env, negocio.id);
  const saldosAFavor = agruparSaldosAFavor(await cargarPagosVigentes(env, negocio.id));
  return armarReporteDeudas(
    { prestamos, facturas: { items: proformas.filter(d => d.saldo > 0.005), totalDocs: proformas.length }, saldosAFavor },
    { cliente: consulta.tipo === 'cliente' ? consulta.cliente : null }
  );
}

async function guardarPagoPendiente(env, negocioId, datos) {
  await env.oficina_ia_db.prepare(
    `INSERT INTO importaciones_pendientes (negocio_id, datos) VALUES (?, ?)
     ON CONFLICT(negocio_id) DO UPDATE SET datos = excluded.datos, creado_en = datetime('now')`
  ).bind(negocioId, JSON.stringify(datos)).run();
}

const liteDoc = d => ({ id: d.id, numero: d.numero, cliente: d.cliente, fecha: d.fecha, saldo: d.saldo });

// "Juan pagó 100": decide a qué factura va y arma la vista previa. NO guarda ningún pago.
async function iniciarRegistroPago(env, negocio, args) {
  const aviso = mensaje => ({ tipo: 'aviso', mensaje });

  const monto = parsearMonto(args.monto);
  if (monto === null) return aviso('No entendí el monto del pago. Dime cuánto pagó, por ejemplo: "Juan pagó 100".');

  const f = interpretarFechaPago(args.fecha);
  if (!f.ok) {
    return aviso(
      f.motivo === 'futura' ? 'Esa fecha todavía no llega: un pago no se puede registrar a futuro.'
        : f.motivo === 'inexistente' ? 'Esa fecha no existe en el calendario. Dímela otra vez (ej. "ayer" o "28/09/2026").'
          : 'No entendí la fecha del pago. Dime "hoy", "ayer" o una fecha como 28/09/2026.'
    );
  }

  const clienteDicho = String(args.cliente ?? '').trim() || null;
  const numeroDoc = normalizarNumeroDocumento(args.numero_documento);
  if (!clienteDicho && !numeroDoc) return aviso('¿De quién es el pago? Dime el cliente o el número de la factura, por ejemplo: "Juan pagó 100".');

  const proformas = await cargarProformasConSaldo(env, negocio.id);
  const avisos = [];
  let candidatos;
  if (numeroDoc) {
    const delNumero = proformas.filter(d => d.numero === numeroDoc);
    if (delNumero.length === 0) return aviso(`No encuentro la factura proforma ${numeroDoc}.`);
    candidatos = delNumero.filter(d => d.saldo > 0.005);
    if (candidatos.length === 0) return aviso(`La factura proforma ${numeroDoc} ya está pagada por completo; no tiene saldo pendiente.`);
    if (clienteDicho) {
      for (const d of candidatos.filter(x => !mismoCliente(clienteDicho, x.cliente))) {
        avisos.push(`La factura proforma ${d.numero} está a nombre de ${d.cliente || 'otro cliente'}, no de ${clienteDicho}. Confirma solo si es la correcta.`);
      }
    }
  } else {
    candidatos = proformas.filter(d => d.saldo > 0.005 && mismoCliente(clienteDicho, d.cliente));
  }

  const base = { tipoPendiente: 'pago', cliente: clienteDicho, monto, fecha: f.fecha, hoy: fechaIsoPanama(), avisos };

  // Varias facturas posibles: NUNCA se elige sola; se muestra la lista con saldos y se pregunta.
  if (candidatos.length > 1) {
    const datos = { ...base, fase: 'eligiendo', candidatos: candidatos.map(liteDoc) };
    await guardarPagoPendiente(env, negocio.id, datos);
    return { tipo: 'pago_pendiente', mensaje: textoElegirDocumento({ cliente: clienteDicho, monto, candidatos: datos.candidatos }) };
  }

  const destinos = candidatos.map(liteDoc);
  if (destinos.length === 0) avisos.push(`No encontré facturas pendientes de ${clienteDicho}. Si confirmas, el dinero queda como saldo a favor suyo.`);
  const datos = await prepararConfirmacionPago(env, negocio.id, { ...base, clienteReferencia: clienteDicho || destinos[0]?.cliente || null }, destinos);
  return { tipo: 'pago_pendiente', mensaje: datos.textoPrevio };
}

// Calcula el reparto, guarda el pendiente en fase 'confirmando' y devuelve el texto de la vista previa.
async function prepararConfirmacionPago(env, negocioId, base, destinos) {
  const plan = repartirPago(base.monto, destinos);
  const datos = {
    ...base,
    fase: 'confirmando',
    plan,
    documentos: destinos.map(d => ({ id: d.id, numero: d.numero, cliente: d.cliente })),
  };
  delete datos.candidatos;
  await guardarPagoPendiente(env, negocioId, datos);
  datos.textoPrevio = textoVistaPrevia({
    cliente: base.cliente, monto: base.monto, fecha: base.fecha, hoy: base.hoy,
    aplicaciones: plan.aplicaciones, saldoAFavor: plan.saldoAFavor, documentos: datos.documentos, avisos: base.avisos || [],
  });
  return datos;
}

async function responderPago(env, negocio, numeroCliente, texto, extra = {}) {
  await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, texto);
  return Response.json({ ok: true, negocio: negocio.slug, pago_pendiente: true, ...extra });
}

async function descartarPago(env, negocio, numeroCliente, texto = 'Listo, cancelé el pago. No registré nada.') {
  await env.oficina_ia_db.prepare('DELETE FROM importaciones_pendientes WHERE negocio_id = ?').bind(negocio.id).run();
  await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, texto);
  return Response.json({ ok: true, pago_cancelado: true });
}

// Respuesta del usuario mientras hay un pago esperando (elegir factura, o confirmar la vista previa).
async function procesarRespuestaPago(env, negocio, numeroCliente, texto, datos) {
  if (datos.fase === 'eligiendo') {
    const r = clasificarRespuestaElegir(texto);
    if (r.accion === 'cancelar') return await descartarPago(env, negocio, numeroCliente);

    let destinos = null;
    if (r.accion === 'mas_antiguo') {
      destinos = ordenarMasAntiguoPrimero(datos.candidatos);
    } else if (r.accion === 'numero') {
      const elegidos = datos.candidatos.filter(c => c.numero === r.numero);
      if (elegidos.length === 1) destinos = elegidos;
    }
    if (!destinos) {
      const ayuda = r.accion === 'numero' ? `La factura ${r.numero} no está en esta lista.\n\n` : '';
      return await responderPago(env, negocio, numeroCliente,
        ayuda + textoElegirDocumento({ cliente: datos.cliente, monto: datos.monto, candidatos: datos.candidatos }));
    }
    const previa = await prepararConfirmacionPago(env, negocio.id, { ...datos, avisos: datos.avisos || [], clienteReferencia: datos.cliente || destinos[0]?.cliente || null }, destinos);
    return await responderPago(env, negocio, numeroCliente, previa.textoPrevio);
  }

  // fase 'confirmando'
  const c = clasificarRespuestaConfirmacion(texto);
  if (c === 'confirmar') return await guardarPago(env, negocio, numeroCliente, datos);
  if (c === 'cancelar') return await descartarPago(env, negocio, numeroCliente);
  return await responderPago(env, negocio, numeroCliente,
    'Responde "sí" para registrar el pago o "no" para cancelarlo. Si algo está mal, di "no" y repítemelo con el dato correcto.');
}

// Guarda el pago (varias filas = un solo batch). Primero "reclama" el pendiente: si otro mensaje
// repetido ya lo consumió, no se guarda dos veces. Antes de escribir se vuelve a verificar que cada
// factura siga vigente y con saldo suficiente.
async function guardarPago(env, negocio, numeroCliente, datos) {
  const db = env.oficina_ia_db;
  const vigentes = await cargarProformasConSaldo(env, negocio.id);
  const porId = new Map(vigentes.map(d => [d.id, d]));
  const cambio = datos.plan.aplicaciones.some(a => {
    const d = porId.get(a.documento_id);
    return !d || d.saldo + 0.005 < a.monto;
  });
  if (cambio) {
    await db.prepare('DELETE FROM importaciones_pendientes WHERE negocio_id = ?').bind(negocio.id).run();
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
      'Algo cambió en esas facturas (ya no existen o su saldo es otro), así que no registré nada. Repíteme el pago y lo reviso de nuevo.');
    return Response.json({ ok: true, pago_no_guardado: true });
  }

  const reclamo = await db.prepare('DELETE FROM importaciones_pendientes WHERE negocio_id = ?').bind(negocio.id).run();
  if (reclamo.meta.changes !== 1) {
    return Response.json({ ok: true, pago_ya_procesado: true });
  }

  const sentencias = datos.plan.aplicaciones.map(a => {
    const d = porId.get(a.documento_id);
    return db.prepare(
      `INSERT INTO pagos (negocio_id, fecha, monto, tipo, documento_id, referencia, concepto, origen)
       VALUES (?, ?, ?, 'cobro_documento', ?, ?, ?, 'chat')`
    ).bind(negocio.id, datos.fecha, a.monto, a.documento_id, d.cliente || datos.clienteReferencia || null, `Factura proforma ${d.numero}`);
  });
  if (datos.plan.saldoAFavor > 0.005) {
    sentencias.push(db.prepare(
      `INSERT INTO pagos (negocio_id, fecha, monto, tipo, documento_id, referencia, concepto, origen)
       VALUES (?, ?, ?, 'saldo_a_favor', NULL, ?, 'Saldo a favor sin aplicar', 'chat')`
    ).bind(negocio.id, datos.fecha, datos.plan.saldoAFavor, datos.clienteReferencia || null));
  }
  await db.batch(sentencias);

  const lineas = [`Listo ✅ Registré el pago de ${formatoMonto(datos.monto)} (${fechaLegible(datos.fecha)}):`];
  for (const a of datos.plan.aplicaciones) {
    const d = porId.get(a.documento_id);
    lineas.push(`• Factura proforma ${d.numero}${d.cliente ? ` (${d.cliente})` : ''}: ${a.saldoDespues <= 0.005 ? 'pagada por completo' : `saldo pendiente ${formatoMonto(a.saldoDespues)}`}`);
  }
  if (datos.plan.saldoAFavor > 0.005) {
    lineas.push(`• ${formatoMonto(datos.plan.saldoAFavor)} quedaron como saldo a favor${datos.clienteReferencia ? ` de ${datos.clienteReferencia}` : ''}`);
  }
  await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, lineas.join('\n'));
  return Response.json({ ok: true, pago_registrado: true });
}

// ── AJUSTES DE PAGOS (fase 1b-3) ─────────────────────────────────
// Anular un pago, anular un documento, aplicar un saldo a favor. Mismas reglas que registrar_pago:
// Groq solo extrae lo que dijo el usuario; el código decide cuál pago/documento es; siempre hay
// vista previa con el efecto y un "sí" explícito; nada se borra (se ANULA y, si el dinero sigue
// siendo del cliente, se vuelve a crear como saldo a favor con la fecha original).

async function negocioTieneDocumentos(env, negocioId) {
  try {
    const f = await env.oficina_ia_db.prepare(
      `SELECT 1 AS hay FROM documentos WHERE negocio_id = ? AND estado != 'anulada'
       UNION ALL SELECT 1 FROM pagos WHERE negocio_id = ? AND anulado = 0 LIMIT 1`
    ).bind(negocioId, negocioId).first();
    return !!f;
  } catch (e) {
    console.log('[WEBHOOK] No pude consultar los documentos del negocio:', e.message);
    return false;
  }
}

// Pagos vigentes (no anulados), el más reciente primero, con el número de factura al que se aplicaron.
async function cargarPagosVigentes(env, negocioId) {
  const { results } = await env.oficina_ia_db.prepare(
    `SELECT p.id, p.fecha, p.monto, p.tipo, p.documento_id, p.referencia, p.concepto, d.numero AS doc_numero
     FROM pagos p LEFT JOIN documentos d ON d.id = p.documento_id
     WHERE p.negocio_id = ? AND p.anulado = 0
     ORDER BY p.fecha DESC, p.id DESC`
  ).bind(negocioId).all();
  return results;
}

const litePago = p => ({ id: p.id, fecha: p.fecha, monto: p.monto, tipo: p.tipo, documento_id: p.documento_id, referencia: p.referencia, doc_numero: p.doc_numero });

async function guardarAjustePendiente(env, negocioId, datos) {
  await guardarPagoPendiente(env, negocioId, { tipoPendiente: 'pago_ajuste', ...datos });
}

async function iniciarAjustePago(env, negocio, args) {
  const accion = String(args.accion ?? '').trim();
  if (accion === 'anular_pago') return await iniciarAnularPago(env, negocio, args);
  if (accion === 'anular_documento') return await iniciarAnularDocumento(env, negocio, args);
  if (accion === 'aplicar_saldo_a_favor') return await iniciarAplicarSaldo(env, negocio, args);
  return { tipo: 'aviso', mensaje: 'No entendí qué quieres hacer. Puedo anular un pago, anular una factura o aplicar un saldo a favor.' };
}

const montoOpcional = v => (v === null || v === undefined || String(v).trim() === '' ? { vacio: true } : { vacio: false, valor: parsearMonto(v) });

// ── anular un pago ──
async function iniciarAnularPago(env, negocio, args) {
  const aviso = mensaje => ({ tipo: 'aviso', mensaje });
  const m = montoOpcional(args.monto);
  if (!m.vacio && m.valor === null) return aviso('No entendí el monto del pago que quieres anular.');
  const monto = m.vacio ? null : m.valor;
  let fecha = null;
  if (String(args.fecha ?? '').trim()) {
    const f = interpretarFechaPago(args.fecha);
    if (!f.ok) return aviso('No entendí la fecha del pago. Dime "ayer" o una fecha como 28/09/2026.');
    fecha = f.fecha;
  }
  const cliente = String(args.cliente ?? '').trim() || null;
  const numero = normalizarNumeroDocumento(args.numero_documento);
  if (!cliente && !numero && monto === null && !fecha) {
    return aviso('¿Cuál pago quieres anular? Dime el cliente, el monto o la factura, por ejemplo: "anula el pago de Ana".');
  }

  const candidatos = filtrarPagos(await cargarPagosVigentes(env, negocio.id), { cliente, monto, numero, fecha });
  if (candidatos.length === 0) return aviso('No encuentro pagos vigentes con esos datos. Revisa el cliente, el monto o la factura.');
  if (candidatos.length > 1) {
    const lista = candidatos.slice(0, 8).map(litePago);
    await guardarAjustePendiente(env, negocio.id, { accion: 'anular_pago', fase: 'eligiendo', subtipo: 'pagos', candidatos: lista });
    return { tipo: 'pago_pendiente', mensaje: textoElegirPago({ candidatos: lista, accion: 'anular' }) };
  }
  return await prepararAnularPago(env, negocio.id, candidatos[0]);
}

async function prepararAnularPago(env, negocioId, pago) {
  let saldoAhora = null;
  if (pago.documento_id != null) {
    const d = (await cargarProformasConSaldo(env, negocioId)).find(x => x.id === pago.documento_id);
    if (d) saldoAhora = d.saldo;
  }
  const plan = planAnularPago(pago, saldoAhora);
  await guardarAjustePendiente(env, negocioId, { accion: 'anular_pago', fase: 'confirmando', plan, resumen: litePago(pago) });
  return { tipo: 'pago_pendiente', mensaje: textoPrevioAnularPago(pago, plan) };
}

// ── anular un documento ──
const nombreDocIndice = d => `${d.tipo === 'cotizacion' ? 'Cotización' : 'Factura proforma'} ${d.numero}`;

async function iniciarAnularDocumento(env, negocio, args) {
  const aviso = mensaje => ({ tipo: 'aviso', mensaje });
  const numero = normalizarNumeroDocumento(args.numero_documento);
  if (!numero) return aviso('¿Cuál documento quieres anular? Dime el número, por ejemplo: "anula la factura 004".');
  const tipo = /cotiz/i.test(String(args.tipo_documento ?? '')) ? 'cotizacion' : 'proforma';

  const { results: filas } = await env.oficina_ia_db.prepare(
    'SELECT id, tipo, numero, cliente, fecha, total, estado, cuadro_id FROM documentos WHERE negocio_id = ? AND tipo = ? AND numero = ?'
  ).bind(negocio.id, tipo, numero).all();
  const etiqueta = tipo === 'cotizacion' ? 'cotización' : 'factura proforma';
  if (filas.length === 0) return aviso(`No encuentro la ${etiqueta} ${numero}.`);
  let cands = filas.filter(d => d.estado !== 'anulada');
  if (cands.length === 0) return aviso(`La ${etiqueta} ${numero} ya está anulada.`);

  // Un número se puede repetir si se borró el último documento: se prefiere el que aún tiene su cuadro.
  const conCuadro = cands.filter(d => d.cuadro_id != null);
  if (conCuadro.length >= 1) cands = conCuadro;
  const cliente = String(args.cliente ?? '').trim() || null;
  if (cands.length > 1 && cliente) {
    const coinciden = cands.filter(d => mismoCliente(cliente, d.cliente));
    if (coinciden.length >= 1) cands = coinciden;
  }
  if (cands.length > 1) {
    const lista = cands.slice(0, 8).map(d => ({ id: d.id, tipo: d.tipo, numero: d.numero, cliente: d.cliente, fecha: d.fecha, total: d.total }));
    await guardarAjustePendiente(env, negocio.id, { accion: 'anular_documento', fase: 'eligiendo', subtipo: 'docs', candidatos: lista });
    const lineas = [`Hay ${lista.length} documentos con ese número. ¿Cuál quieres anular?`, ''];
    lista.forEach((d, i) => lineas.push(`${i + 1}. ${nombreDocIndice(d)}${d.cliente ? ` (${d.cliente})` : ''} — ${fechaLegible(d.fecha)} — ${formatoMonto(d.total)}`));
    lineas.push('', 'Dime el número de la lista (ej. "1"). Responde "no" para cancelar.');
    return { tipo: 'pago_pendiente', mensaje: lineas.join('\n') };
  }
  const doc = cands[0];
  if (doc.tipo === 'cotizacion' && doc.estado === 'convertida') {
    return aviso(`La cotización ${doc.numero} ya se convirtió en factura proforma. Si quieres anular, anula la factura.`);
  }
  return await prepararAnularDocumento(env, negocio.id, doc);
}

async function prepararAnularDocumento(env, negocioId, doc) {
  const pagos = (await cargarPagosVigentes(env, negocioId)).filter(p => p.documento_id === doc.id);
  const plan = planAnularDocumento(doc, pagos);
  await guardarAjustePendiente(env, negocioId, { accion: 'anular_documento', fase: 'confirmando', plan, resumen: { id: doc.id, tipo: doc.tipo, numero: doc.numero, cliente: doc.cliente, total: doc.total } });
  return { tipo: 'pago_pendiente', mensaje: textoPrevioAnularDocumento(doc, plan) };
}

// ── aplicar saldo a favor ──
async function iniciarAplicarSaldo(env, negocio, args) {
  const aviso = mensaje => ({ tipo: 'aviso', mensaje });
  const cliente = String(args.cliente ?? '').trim() || null;
  if (!cliente) return aviso('¿De qué cliente es el saldo a favor? Por ejemplo: "aplica el saldo a favor de Ana a la factura 004".');
  const m = montoOpcional(args.monto);
  if (!m.vacio && m.valor === null) return aviso('No entendí el monto que quieres aplicar.');
  const numero = normalizarNumeroDocumento(args.numero_documento);

  const saldoRows = filtrarPagos(await cargarPagosVigentes(env, negocio.id), { cliente }).filter(p => p.tipo === 'saldo_a_favor')
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.id - b.id));
  const disponible = Math.round(saldoRows.reduce((acc, p) => acc + Number(p.monto), 0) * 100) / 100;
  if (disponible <= 0.005) return aviso(`${cliente} no tiene saldo a favor registrado.`);
  if (!m.vacio && m.valor > disponible + 0.005) return aviso(`Solo hay ${formatoMonto(disponible)} de saldo a favor de ${cliente}, no ${formatoMonto(m.valor)}.`);
  const monto = m.vacio ? disponible : m.valor;

  const proformas = await cargarProformasConSaldo(env, negocio.id);
  const avisos = [];
  let candidatos;
  if (numero) {
    const delNumero = proformas.filter(d => d.numero === numero);
    if (delNumero.length === 0) return aviso(`No encuentro la factura proforma ${numero}.`);
    candidatos = delNumero.filter(d => d.saldo > 0.005);
    if (candidatos.length === 0) return aviso(`La factura proforma ${numero} ya está pagada por completo; no tiene saldo pendiente.`);
    for (const d of candidatos.filter(x => !mismoCliente(cliente, x.cliente))) {
      avisos.push(`La factura proforma ${d.numero} está a nombre de ${d.cliente || 'otro cliente'}, no de ${cliente}. Confirma solo si es la correcta.`);
    }
  } else {
    candidatos = proformas.filter(d => d.saldo > 0.005 && mismoCliente(cliente, d.cliente));
    if (candidatos.length === 0) return aviso(`${cliente} no tiene facturas pendientes a las que aplicar el saldo a favor.`);
  }

  const base = { accion: 'aplicar_saldo_a_favor', cliente, monto, avisos };
  if (candidatos.length > 1) {
    const lista = candidatos.map(liteDoc);
    await guardarAjustePendiente(env, negocio.id, { ...base, fase: 'eligiendo', subtipo: 'facturas', candidatos: lista });
    return { tipo: 'pago_pendiente', mensaje: textoElegirDocumento({ cliente, monto, candidatos: lista, concepto: 'el saldo a favor' }) };
  }
  return await prepararAplicarSaldo(env, negocio.id, base, candidatos.map(liteDoc));
}

async function prepararAplicarSaldo(env, negocioId, base, destinos) {
  const saldoRows = filtrarPagos(await cargarPagosVigentes(env, negocioId), { cliente: base.cliente }).filter(p => p.tipo === 'saldo_a_favor')
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.id - b.id));
  const disponible = Math.round(saldoRows.reduce((acc, p) => acc + Number(p.monto), 0) * 100) / 100;
  const reparto = repartirPago(Math.min(base.monto, disponible), destinos);
  if (reparto.aplicaciones.length === 0) {
    await env.oficina_ia_db.prepare('DELETE FROM importaciones_pendientes WHERE negocio_id = ?').bind(negocioId).run();
    return { tipo: 'aviso', mensaje: 'No hay saldo pendiente en esas facturas para aplicar.' };
  }
  const aplicado = Math.round(reparto.aplicaciones.reduce((acc, a) => acc + a.monto, 0) * 100) / 100;
  const plan = planAplicarSaldo(saldoRows.map(p => ({ id: p.id, fecha: p.fecha, monto: p.monto, referencia: p.referencia })), reparto.aplicaciones);
  const restante = Math.round((disponible - aplicado) * 100) / 100;
  const resumen = { aplicaciones: reparto.aplicaciones, documentos: destinos.map(d => ({ id: d.id, numero: d.numero, cliente: d.cliente })), disponible, restante };
  await guardarAjustePendiente(env, negocioId, { ...base, fase: 'confirmando', plan, resumen });
  let texto = textoPrevioAplicarSaldo({ cliente: base.cliente, aplicaciones: reparto.aplicaciones, documentos: resumen.documentos, disponible, restante });
  if (base.avisos?.length) texto = texto.replace('\n\n¿Lo aplico?', `\n\n${base.avisos.map(a => `⚠️ ${a}`).join('\n')}\n\n¿Lo aplico?`);
  return { tipo: 'pago_pendiente', mensaje: texto };
}

// ── respuesta del usuario a un ajuste pendiente ──
async function procesarRespuestaAjuste(env, negocio, numeroCliente, texto, datos) {
  const cancelar = () => descartarPago(env, negocio, numeroCliente, 'Listo, cancelé. No cambié nada.');

  if (datos.fase === 'eligiendo') {
    if (datos.subtipo === 'pagos' || datos.subtipo === 'docs') {
      const r = clasificarRespuestaElegirIndice(texto, datos.candidatos.length);
      if (r.accion === 'cancelar') return await cancelar();
      if (r.accion !== 'indice') {
        const relista = datos.subtipo === 'pagos'
          ? textoElegirPago({ candidatos: datos.candidatos, accion: 'anular' })
          : `Dime el número de la lista (1 a ${datos.candidatos.length}) o "no" para cancelar.`;
        return await responderPago(env, negocio, numeroCliente, relista);
      }
      const elegido = datos.candidatos[r.indice - 1];
      let previa;
      if (datos.subtipo === 'pagos') {
        const fresco = (await cargarPagosVigentes(env, negocio.id)).find(p => p.id === elegido.id);
        if (!fresco) {
          await env.oficina_ia_db.prepare('DELETE FROM importaciones_pendientes WHERE negocio_id = ?').bind(negocio.id).run();
          return await responderPago(env, negocio, numeroCliente, 'Ese pago ya no está vigente, así que no hice nada.');
        }
        previa = await prepararAnularPago(env, negocio.id, fresco);
      } else {
        const doc = await env.oficina_ia_db.prepare('SELECT id, tipo, numero, cliente, fecha, total, estado FROM documentos WHERE id = ? AND negocio_id = ?').bind(elegido.id, negocio.id).first();
        if (!doc || doc.estado === 'anulada') {
          await env.oficina_ia_db.prepare('DELETE FROM importaciones_pendientes WHERE negocio_id = ?').bind(negocio.id).run();
          return await responderPago(env, negocio, numeroCliente, 'Ese documento ya está anulado, así que no hice nada.');
        }
        if (doc.tipo === 'cotizacion' && doc.estado === 'convertida') {
          await env.oficina_ia_db.prepare('DELETE FROM importaciones_pendientes WHERE negocio_id = ?').bind(negocio.id).run();
          return await responderPago(env, negocio, numeroCliente, `La cotización ${doc.numero} ya se convirtió en factura proforma. Si quieres anular, anula la factura.`);
        }
        previa = await prepararAnularDocumento(env, negocio.id, doc);
      }
      return await responderPago(env, negocio, numeroCliente, previa.mensaje);
    }

    // subtipo 'facturas' (aplicar saldo): número de factura o "al más antiguo"
    const r = clasificarRespuestaElegir(texto);
    if (r.accion === 'cancelar') return await cancelar();
    let destinos = null;
    if (r.accion === 'mas_antiguo') destinos = ordenarMasAntiguoPrimero(datos.candidatos);
    else if (r.accion === 'numero') {
      const elegidos = datos.candidatos.filter(c => c.numero === r.numero);
      if (elegidos.length === 1) destinos = elegidos;
    }
    if (!destinos) {
      const ayuda = r.accion === 'numero' ? `La factura ${r.numero} no está en esta lista.\n\n` : '';
      return await responderPago(env, negocio, numeroCliente,
        ayuda + textoElegirDocumento({ cliente: datos.cliente, monto: datos.monto, candidatos: datos.candidatos, concepto: 'el saldo a favor' }));
    }
    const previa = await prepararAplicarSaldo(env, negocio.id, { accion: datos.accion, cliente: datos.cliente, monto: datos.monto, avisos: datos.avisos || [] }, destinos);
    return await responderPago(env, negocio, numeroCliente, previa.mensaje);
  }

  // fase 'confirmando'
  const c = clasificarRespuestaConfirmacion(texto);
  if (c === 'confirmar') return await guardarAjuste(env, negocio, numeroCliente, datos);
  if (c === 'cancelar') return await cancelar();
  return await responderPago(env, negocio, numeroCliente, 'Responde "sí" para confirmar o "no" para cancelar.');
}

// Aplica el ajuste: UN batch (anular + crear + marcar documento). Antes: se vuelve a verificar que todo
// siga igual que en la vista previa y se "reclama" el pendiente para que un "sí" repetido no se aplique dos veces.
async function guardarAjuste(env, negocio, numeroCliente, datos) {
  const db = env.oficina_ia_db;
  const plan = datos.plan;
  const noGuardado = async () => {
    await db.prepare('DELETE FROM importaciones_pendientes WHERE negocio_id = ?').bind(negocio.id).run();
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
      'Algo cambió desde la vista previa (un pago o documento ya no está igual), así que no cambié nada. Pídemelo de nuevo y lo reviso.');
    return Response.json({ ok: true, ajuste_no_guardado: true });
  };

  const vigentes = new Set((await cargarPagosVigentes(env, negocio.id)).map(p => p.id));
  if (plan.anular.some(id => !vigentes.has(id))) return await noGuardado();
  if (plan.documentoAnular) {
    const d = await db.prepare('SELECT estado FROM documentos WHERE id = ? AND negocio_id = ?').bind(plan.documentoAnular, negocio.id).first();
    if (!d || d.estado === 'anulada') return await noGuardado();
  }
  const cobros = plan.nuevos.filter(n => n.tipo === 'cobro_documento');
  if (cobros.length) {
    const porId = new Map((await cargarProformasConSaldo(env, negocio.id)).map(d => [d.id, d]));
    const sumaPorDoc = new Map();
    for (const n of cobros) sumaPorDoc.set(n.documento_id, (sumaPorDoc.get(n.documento_id) || 0) + n.monto);
    for (const [docId, suma] of sumaPorDoc) {
      const d = porId.get(docId);
      if (!d || d.saldo + 0.005 < suma) return await noGuardado();
    }
  }

  const reclamo = await db.prepare('DELETE FROM importaciones_pendientes WHERE negocio_id = ?').bind(negocio.id).run();
  if (reclamo.meta.changes !== 1) return Response.json({ ok: true, ajuste_ya_procesado: true });

  const motivo = datos.accion === 'anular_pago' ? 'Anulado por el usuario'
    : datos.accion === 'anular_documento' ? 'Documento anulado'
      : 'Aplicado a una factura desde saldo a favor';
  const sentencias = plan.anular.map(id => db.prepare(
    'UPDATE pagos SET anulado = 1, motivo_anulacion = ? WHERE id = ? AND negocio_id = ? AND anulado = 0'
  ).bind(motivo, id, negocio.id));
  for (const n of plan.nuevos) {
    sentencias.push(db.prepare(
      `INSERT INTO pagos (negocio_id, fecha, monto, tipo, documento_id, referencia, concepto, origen)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'chat')`
    ).bind(negocio.id, n.fecha, n.monto, n.tipo, n.documento_id ?? null, n.referencia ?? null, n.concepto ?? null));
  }
  if (plan.documentoAnular) {
    sentencias.push(db.prepare("UPDATE documentos SET estado = 'anulada' WHERE id = ? AND negocio_id = ?").bind(plan.documentoAnular, negocio.id));
  }
  await db.batch(sentencias);

  let texto;
  if (datos.accion === 'anular_pago') {
    const p = datos.resumen;
    texto = `Listo ✅ Anulé el pago de ${formatoMonto(p.monto)}${p.referencia ? ` de ${p.referencia}` : ''} (${fechaLegible(p.fecha)}). No se borró: quedó anulado.` +
      (plan.saldoDespues != null ? `\nLa Factura proforma ${p.doc_numero} vuelve a deber ${formatoMonto(plan.saldoDespues)}.` : '') +
      '\nSi era un error de monto, dime el pago correcto (ej. "Ana pagó 20").';
  } else if (datos.accion === 'anular_documento') {
    const d = datos.resumen;
    texto = `Listo ✅ Anulé la ${nombreDocIndice(d)}${d.cliente ? ` (${d.cliente})` : ''}. El documento se conserva marcado como anulado.` +
      (plan.totalPagos > 0.005 ? `\n${formatoMonto(plan.totalPagos)} que ya había pagado quedaron como saldo a favor${d.cliente ? ` de ${d.cliente}` : ''}.` : '');
  } else {
    const r = datos.resumen;
    const porId = new Map(r.documentos.map(d => [d.id, d]));
    const lineas = [`Listo ✅ Apliqué saldo a favor${datos.cliente ? ` de ${datos.cliente}` : ''}:`];
    for (const a of r.aplicaciones) {
      const d = porId.get(a.documento_id);
      lineas.push(`• Factura proforma ${d.numero}: ${a.saldoDespues <= 0.005 ? 'pagada por completo' : `saldo pendiente ${formatoMonto(a.saldoDespues)}`}`);
    }
    lineas.push(r.restante > 0.005 ? `Quedan ${formatoMonto(r.restante)} de saldo a favor.` : 'Ya no queda saldo a favor.');
    texto = lineas.join('\n');
  }
  await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, texto);
  return Response.json({ ok: true, ajuste_registrado: true });
}

// Misma idea que confirmarImportacion, pero para un reporte tipo
// "secciones": se guarda en la MISMA tabla `cuadros` (así aplicarAccion
// lo encuentra con obtenerCuadros/elegirCuadro de siempre), marcando
// estructura.tipo = 'secciones' para poder diferenciarlo. La columna
// "filas" no se usa para este tipo (todo vive en "estructura") — se
// guarda como '[]' nada más para no dejarla NULL.
async function confirmarImportacionSecciones(env, negocio, numeroCliente, datos) {
  const cuadrosExistentes = await obtenerCuadros(env, negocio.id);
  const nombreNormalizado = normalizarClave(datos.nombreCuadro);
  const yaExiste = cuadrosExistentes.find(c => normalizarClave(c.nombre_cuadro) === nombreNormalizado);
  const nombreFinal = yaExiste ? `${datos.nombreCuadro} (importado)` : datos.nombreCuadro;

  const estructura = JSON.stringify({
    tipo: 'secciones',
    titulo: datos.titulo,
    subtitulo: datos.subtitulo || undefined,
    estadisticas: datos.estadisticas,
    secciones: datos.secciones,
  });

  await env.oficina_ia_db.prepare(
    'INSERT INTO cuadros (negocio_id, nombre_cuadro, estructura, filas) VALUES (?, ?, ?, ?)'
  ).bind(negocio.id, nombreFinal, estructura, '[]').run();

  await env.oficina_ia_db.prepare('DELETE FROM importaciones_pendientes WHERE negocio_id = ?').bind(negocio.id).run();

  const aviso = yaExiste
    ? ` (ya tenías un reporte llamado "${datos.nombreCuadro}", así que a este le puse "${nombreFinal}")`
    : '';
  await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente,
    `Listo, creé el reporte "${nombreFinal}"${aviso} ✅. Ya puedes pedirme la imagen o el Excel cuando quieras.`);

  return Response.json({ ok: true, cuadro_creado: nombreFinal, tipo: 'secciones' });
}

// Llamada chica y aparte a Groq — SOLO para extraer a qué registro,
// columna y valor se refiere una corrección en texto libre. No forma
// parte de las 7 herramientas normales, y tampoco calcula nada.
// Corrección de un documento pendiente (cotización o factura de foto).
// Groq solo EXTRAE qué dato y qué valor; cotizacion.js decide y recalcula.
async function corregirDocumentoPendiente(env, negocio, numeroCliente, texto, datos) {
  let correccion = null;
  try {
    correccion = await interpretarCorreccionDocumento(texto, describirParaCorreccion(datos), env.GROQ_API_KEY);
  } catch (e) {
    console.log('[WEBHOOK] Error interpretando corrección de documento:', e.message);
  }
  console.log('[WEBHOOK] Corrección de documento extraída por Groq:', JSON.stringify(correccion));

  const r = aplicarCorreccionDocumento(datos, correccion);
  if (!r.ok) {
    await enviarMensaje(negocio.wa_token, negocio.phone_number_id, numeroCliente, r.mensaje);
    return Response.json({ ok: true, correccion_documento_rechazada: true });
  }

  const nuevo = r.datos;
  if (nuevo.origen !== 'texto') nuevo.validacion = validarContraTotales(nuevo.columnasInternas, nuevo.filas, nuevo.filaTotales);

  await env.oficina_ia_db.prepare(
    "UPDATE importaciones_pendientes SET datos = ?, creado_en = datetime('now') WHERE negocio_id = ?"
  ).bind(JSON.stringify(nuevo), negocio.id).run();

  await enviarVistaPreviaImportacion(env, negocio, numeroCliente, nuevo);
  return Response.json({ ok: true, correccion_documento_aplicada: true });
}

async function interpretarCorreccionDocumento(textoUsuario, contexto, groqApiKey) {
  const lista = a => (a && a.length ? a.join(', ') : '(ninguno)');
  const prompt =
    `El usuario está corrigiendo un documento (cotización o factura) que todavía no se ha guardado.\n` +
    `Datos del encabezado que ya existen: ${lista(contexto.etiquetas)}.\n` +
    `Datos del encabezado que se pueden agregar: ${lista(contexto.agregables)}.\n` +
    `Columnas de las líneas que se pueden cambiar: ${lista(contexto.columnas)}.\n` +
    `Líneas del documento: ${contexto.descripciones.map((d, i) => `${i + 1}. ${d}`).join('; ') || '(ninguna)'}.\n\n` +
    `Extrae UNA sola corrección del mensaje. Responde SOLO con JSON, sin texto adicional: ` +
    `{"objetivo": "encabezado" | "linea" | "agregar_linea" | "quitar_linea", "campo": "...", "valor": "...", "linea": "...", "descripcion": "...", "cantidad": "...", "precio": "...", "itbms": "..."}. Los campos que no apliquen van null.\n` +
    `- objetivo "encabezado": "campo" debe ser EXACTAMENTE uno de los datos de encabezado de arriba (existentes o agregables) y "valor" el nuevo texto tal cual lo dijo (ej. el nombre completo del cliente). "linea" va null.\n` +
    `- objetivo "linea": "campo" debe ser EXACTAMENTE una de las columnas de arriba; "linea" es la descripción de la línea tal cual la dijo el usuario, o su número si dijo un número; "valor" es el nuevo valor tal cual lo dijo, sin calcular nada. Para el ITBMS, "valor" es la tasa tal cual la dijo (ej. "10%", "exento").\n` +
    `- objetivo "agregar_linea": el usuario quiere AGREGAR un producto o servicio nuevo. "descripcion", "cantidad" y "precio" (precio UNITARIO) tal cual los dijo, o null si no los dijo — nunca los inventes. "itbms" SOLO si dijo una tasa para esa línea (ej. "10%", "exento"), si no null.\n` +
    `- objetivo "quitar_linea": el usuario quiere QUITAR una línea. "linea" es la descripción tal cual la dijo, o su número si dijo un número.\n` +
    `- NUNCA calcules ni deduzcas totales: si el usuario da un total, responde con objetivo null.\n` +
    `- Si no puedes identificarlo con certeza: {"objetivo": null, "campo": null, "valor": null, "linea": null}.\n\n` +
    `Mensaje del usuario: ${JSON.stringify(textoUsuario)}`;

  const respuesta = await fetchGroq('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 400,
      response_format: { type: 'json_object' },
    }),
  });
  const data = await respuesta.json();
  if (data.error) throw new Error(`Groq (corrección de documento): ${data.error.message}`);
  const mensaje = data.choices?.[0]?.message;
  const texto = (mensaje?.content || mensaje?.reasoning_content || mensaje?.reasoning || '').trim();
  const limpio = texto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(limpio);
}

async function interpretarCorreccion(textoUsuario, columnasDisponibles, groqApiKey) {
  const respuesta = await fetchGroq('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: [{
        role: 'user',
        content: `El usuario está corrigiendo un dato de un cuadro que todavía no se ha guardado. ` +
          `Las columnas disponibles son: ${columnasDisponibles.join(', ')}.\n\n` +
          `Del siguiente mensaje, extrae a qué registro se refiere (nombre), qué columna corregir ` +
          `(debe ser EXACTAMENTE uno de los nombres de columna de arriba) y el nuevo valor tal cual lo dijo. ` +
          `Responde SOLO con JSON, sin texto adicional: {"nombre": "...", "campo": "...", "valor": "..."}. ` +
          `Si no puedes identificarlo con certeza, responde {"nombre": null, "campo": null, "valor": null}.\n\n` +
          `Mensaje del usuario: "${textoUsuario}"`,
      }],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    }),
  });
  const data = await respuesta.json();
  if (data.error) throw new Error(`Groq (corrección): ${data.error.message}`);
  const mensaje = data.choices?.[0]?.message;
  const texto = (mensaje?.content || mensaje?.reasoning_content || mensaje?.reasoning || '').trim();
  const limpio = texto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(limpio);
}

// Devuelve el id de la fila guardada (o null si no se pudo guardar).
async function guardarMensaje(env, negocioId, rol, mensaje, tipo) {
  try {
    const r = await env.oficina_ia_db.prepare(
      'INSERT INTO conversaciones (negocio_id, rol, mensaje, tipo) VALUES (?, ?, ?, ?)'
    ).bind(negocioId, rol, mensaje, tipo).run();
    return r?.meta?.last_row_id ?? null;
  } catch (e) {
    console.log('[WEBHOOK] Error guardando mensaje:', e.message);
    return null;
  }
}

// Si Groq falla (429, 413, 400, red caída), el mensaje del usuario quedaría en el historial sin respuesta
// y el SIGUIENTE mensaje haría que Groq intente cumplir también ese. Se borra solo esa fila (del usuario y del negocio).
async function descartarMensajeFallido(env, negocioId, id) {
  if (!id) return;
  try {
    await env.oficina_ia_db.prepare(
      "DELETE FROM conversaciones WHERE id = ? AND negocio_id = ? AND rol = 'usuario'"
    ).bind(id, negocioId).run();
  } catch (e) {
    console.log('[WEBHOOK] No pude descartar el mensaje fallido del historial:', e.message);
  }
}

// Marca estructural (no por texto) de que un flujo de pago/ajuste terminó. Los turnos de un flujo
// pendiente no se guardan en `conversaciones`, así que la última fila del bot es la que abrió el
// flujo: esa es la que se marca. Si el flujo sigue abierto (lista → vista previa) no se marca.
async function marcarFlujoPagoCerrado(env, negocioId) {
  try {
    const sigue = await env.oficina_ia_db.prepare(
      'SELECT 1 AS x FROM importaciones_pendientes WHERE negocio_id = ?'
    ).bind(negocioId).first();
    if (sigue) return;
    await env.oficina_ia_db.prepare(
      "UPDATE conversaciones SET cerrado = 1 WHERE id = (SELECT MAX(id) FROM conversaciones WHERE negocio_id = ? AND rol = 'asistente')"
    ).bind(negocioId).run();
  } catch (e) {
    console.log('[WEBHOOK] No se pudo marcar el flujo como cerrado:', e.message);
  }
}

async function transcribirAudioWA(mediaId, waToken, groqApiKey) {
  // 1. Obtener la URL temporal del archivo de audio
  const mediaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${waToken}` },
  });
  const mediaData = await mediaRes.json();
  if (!mediaData.url) throw new Error('No se pudo obtener la URL del audio desde Meta');

  // 2. Descargar el audio (requiere el mismo token de WhatsApp)
  const audioRes = await fetch(mediaData.url, {
    headers: { Authorization: `Bearer ${waToken}` },
  });
  if (!audioRes.ok) throw new Error('No se pudo descargar el audio');
  const audioBuffer = await audioRes.arrayBuffer();

  // 3. Enviar a Groq Whisper para transcribir
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'audio.ogg');
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('language', 'es');
  formData.append('response_format', 'text');

  const whisperRes = await fetchGroq('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqApiKey}` },
    body: formData,
  });

  if (!whisperRes.ok) {
    const err = await whisperRes.text();
    throw new Error(`Groq Whisper error: ${err}`);
  }

  return (await whisperRes.text()).trim();
}

// Meta (usuarios con nombre de usuario): si la persona activó su nombre
// de usuario, el webhook puede no traer su teléfono ("from") sino solo su
// BSUID (ej. "PA.24879956865035702"). Para responderle: teléfono -> campo
// "to"; BSUID -> campo "recipient" (y sin "to"). Con teléfono todo sigue
// exactamente igual que antes.
function destinatarioWhatsApp(destino) {
  const esBsuid = /^[A-Za-z]{2}\.(?:ENT\.)?[A-Za-z0-9]+$/.test(String(destino));
  return esBsuid ? { recipient: destino } : { to: destino };
}

async function enviarMensaje(waToken, phoneNumberId, to, texto) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${waToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      ...destinatarioWhatsApp(to),
      type: 'text',
      text: { body: texto },
    }),
  });
  return res.json();
}

async function enviarImagenPorLink(waToken, phoneNumberId, to, imageUrl, caption) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${waToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      ...destinatarioWhatsApp(to),
      type: 'image',
      image: { link: imageUrl, caption },
    }),
  });
  return res.json();
}

// Genera el .xlsx, lo sube a Meta (POST /media) y lo manda como
// documento. Nunca deja al usuario sin respuesta: si algo falla,
// le avisa por texto.
async function enviarExcelCuadro(negocio, to, datosCuadro, caption) {
  const avisarError = () => enviarMensaje(
    negocio.wa_token, negocio.phone_number_id, to,
    'No pude generar el Excel en este momento. Intenta de nuevo en unos minutos.'
  );

  let archivo;
  try {
    archivo = generarExcelCuadro(
      datosCuadro.nombreCuadro, datosCuadro.columnas, datosCuadro.filas, datosCuadro.reglas,
      datosCuadro.subtitulo, true, datosCuadro.extras || {}
    );
  } catch (e) {
    console.log('[WEBHOOK] Error generando Excel:', e.message);
    return avisarError();
  }

  // 1. Subir el archivo a Meta. NO se pone Content-Type a mano:
  //    fetch lo arma solo (con el boundary) al usar FormData.
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', archivo.mime);
  form.append('file', new Blob([archivo.bytes], { type: archivo.mime }), archivo.nombreArchivo);

  const subida = await fetch(`https://graph.facebook.com/v21.0/${negocio.phone_number_id}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${negocio.wa_token}` },
    body: form,
  });
  const subidaData = await subida.json();
  if (!subidaData.id) {
    console.log('[WEBHOOK] Error subiendo Excel a Meta:', JSON.stringify(subidaData));
    return avisarError();
  }

  // 2. Mandarlo como documento
  let texto = caption;
  if (archivo.columnasSinFormula.length > 0) {
    texto += `\nNota: las columnas ${archivo.columnasSinFormula.join(', ')} salen con valores fijos, no con fórmula.`;
  }
  if (archivo.camposPendientes && archivo.camposPendientes.length > 0) {
    texto += `\n⚠️ Quedaron vacíos, sin identificar con seguridad: ${archivo.camposPendientes.join(', ')}. Complétalos directo en el Excel.`;
  }
  if (archivo.pieSinFormula && archivo.pieSinFormula.length > 0) {
    texto += `\nNota: ${archivo.pieSinFormula.join(', ')} salen con valor fijo, no con fórmula.`;
  }
  const res = await fetch(`https://graph.facebook.com/v21.0/${negocio.phone_number_id}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${negocio.wa_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      ...destinatarioWhatsApp(to),
      type: 'document',
      document: { id: subidaData.id, filename: archivo.nombreArchivo, caption: texto.slice(0, 1000) },
    }),
  });
  return res.json();
}

// Genera el PDF (pdfCuadro.js, async), lo sube a Meta (POST /media) y lo manda
// como documento. Mismo patrón que enviarExcelCuadro: nunca deja al usuario sin
// respuesta; si algo falla, le avisa por texto.
async function enviarPdfCuadro(negocio, to, datosCuadro, caption) {
  const avisarError = () => enviarMensaje(
    negocio.wa_token, negocio.phone_number_id, to,
    'No pude generar el PDF en este momento. Intenta de nuevo en unos minutos.'
  );

  let archivo;
  try {
    archivo = await generarPdfCuadro(
      datosCuadro.nombreCuadro, datosCuadro.columnas, datosCuadro.filas, datosCuadro.reglas,
      datosCuadro.subtitulo, true, datosCuadro.extras || {}
    );
  } catch (e) {
    console.log('[WEBHOOK] Error generando PDF:', e.message);
    return avisarError();
  }

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', archivo.mime);
  form.append('file', new Blob([archivo.bytes], { type: archivo.mime }), archivo.nombreArchivo);

  const subida = await fetch(`https://graph.facebook.com/v21.0/${negocio.phone_number_id}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${negocio.wa_token}` },
    body: form,
  });
  const subidaData = await subida.json();
  if (!subidaData.id) {
    console.log('[WEBHOOK] Error subiendo PDF a Meta:', JSON.stringify(subidaData));
    return avisarError();
  }

  let texto = caption;
  if (archivo.camposPendientes && archivo.camposPendientes.length > 0) {
    texto += `\n⚠️ Quedaron por completar, sin identificar con seguridad: ${archivo.camposPendientes.join(', ')}.`;
  }
  const res = await fetch(`https://graph.facebook.com/v21.0/${negocio.phone_number_id}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${negocio.wa_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      ...destinatarioWhatsApp(to),
      type: 'document',
      document: { id: subidaData.id, filename: archivo.nombreArchivo, caption: texto.slice(0, 1000) },
    }),
  });
  return res.json();
}

// Misma idea que enviarExcelCuadro, pero para un reporte tipo
// "secciones" — usa filasSinFormula (fila > etiqueta) en vez de
// columnasSinFormula, ya que aquí no hay columnas sino filas de
// etiqueta/valor dentro de cada sección.
async function enviarExcelReporteSecciones(negocio, to, datosReporteSecciones, caption) {
  const avisarError = () => enviarMensaje(
    negocio.wa_token, negocio.phone_number_id, to,
    'No pude generar el Excel en este momento. Intenta de nuevo en unos minutos.'
  );

  let archivo;
  try {
    archivo = generarExcelReporteSecciones(datosReporteSecciones);
  } catch (e) {
    console.log('[WEBHOOK] Error generando Excel de reporte por secciones:', e.message);
    return avisarError();
  }

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', archivo.mime);
  form.append('file', new Blob([archivo.bytes], { type: archivo.mime }), archivo.nombreArchivo);

  const subida = await fetch(`https://graph.facebook.com/v21.0/${negocio.phone_number_id}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${negocio.wa_token}` },
    body: form,
  });
  const subidaData = await subida.json();
  if (!subidaData.id) {
    console.log('[WEBHOOK] Error subiendo Excel de secciones a Meta:', JSON.stringify(subidaData));
    return avisarError();
  }

  let texto = caption;
  if (archivo.filasSinFormula.length > 0) {
    texto += `\nNota: las filas ${archivo.filasSinFormula.join(', ')} salen con valores fijos, no con fórmula.`;
  }
  const res = await fetch(`https://graph.facebook.com/v21.0/${negocio.phone_number_id}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${negocio.wa_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      ...destinatarioWhatsApp(to),
      type: 'document',
      document: { id: subidaData.id, filename: archivo.nombreArchivo, caption: texto.slice(0, 1000) },
    }),
  });
  return res.json();
}

// Genera el .docx (motorCartas.js), lo sube a Meta (/media) y lo
// manda como documento — mismo patrón que enviarExcelCuadro. Al
// final registra el documento en documentos_generados (tabla que ya
// existía en D1, vacía, sin usar).
async function enviarCartaGenerada(env, negocio, to, datosCarta, caption) {
  const avisarError = () => enviarMensaje(
    negocio.wa_token, negocio.phone_number_id, to,
    'No pude generar el documento en este momento. Intenta de nuevo en unos minutos.'
  );

  const plantilla = await obtenerPlantilla(env, datosCarta.plantillaId);
  if (!plantilla) return avisarError();

  const configNegocio = await env.oficina_ia_db.prepare(
    'SELECT membrete_carta, firma_carta FROM configuracion_negocio WHERE negocio_id = ?'
  ).bind(negocio.id).first();

  let archivo;
  try {
    archivo = await generarDocxCarta(plantilla, datosCarta.campos, configNegocio);
  } catch (e) {
    console.log('[WEBHOOK] Error generando el .docx:', e.message);
    return avisarError();
  }

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', archivo.mime);
  form.append('file', new Blob([archivo.bytes], { type: archivo.mime }), archivo.nombreArchivo);

  const subida = await fetch(`https://graph.facebook.com/v21.0/${negocio.phone_number_id}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${negocio.wa_token}` },
    body: form,
  });
  const subidaData = await subida.json();
  if (!subidaData.id) {
    console.log('[WEBHOOK] Error subiendo carta a Meta:', JSON.stringify(subidaData));
    return avisarError();
  }

  const res = await fetch(`https://graph.facebook.com/v21.0/${negocio.phone_number_id}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${negocio.wa_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      ...destinatarioWhatsApp(to),
      type: 'document',
      document: { id: subidaData.id, filename: archivo.nombreArchivo, caption: (caption || '').slice(0, 1000) },
    }),
  });
  const resultado = await res.json();

  // Auditoría — no debe tumbar el envío si falla
  try {
    await env.oficina_ia_db.prepare(
      'INSERT INTO documentos_generados (negocio_id, tipo, nombre, formato, solicitud) VALUES (?, ?, ?, ?, ?)'
    ).bind(negocio.id, plantilla.id, plantilla.nombre, 'docx', JSON.stringify(datosCarta.campos)).run();
  } catch (e) {
    console.log('[WEBHOOK] Error registrando en documentos_generados:', e.message);
  }

  return resultado;
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}