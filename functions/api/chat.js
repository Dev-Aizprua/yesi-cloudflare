import Groq from 'groq-sdk';
import { tavily } from '@tavily/core';

function requiereMotorPro(mensaje) {
  return /\b(busca|encuentra|analiza|investiga|prospectos|negocios|empresas|restaurantes|hoteles|ferreter|tiendas|agencias|correo|propuesta|redacta|elabora|compara|evalua|farmacias|clinicas|gimnasios|bares|cafes|supermercados|bancos|peluquerias|spa|salon|dentistas|medicos|abogados|contadores|dame|lista|muestra|hay)\b/i.test(mensaje);
}

function requiereBusquedaLocal(mensaje) {
  const msg = mensaje.toLowerCase();
  // Debe contener un tipo de negocio físico — no palabras genéricas como "busca noticias"
  const tieneNegocio = /\b(negocios|empresas|restaurantes|hoteles|ferreter|tiendas|agencias|farmacias|clinicas|gimnasios|bares|cafes|supermercados|bancos|peluquerias|spa|salon|dentistas|medicos|abogados|contadores|locales|comercios)\b/i.test(msg);
  // Palabras que EXCLUYEN la búsqueda local aunque tengan "busca"
  const esConsultaGeneral = /\b(noticias|noticia|clima|precio|dolar|tasa|ley|decreto|gobierno|politica|economia|deporte|futbol|farandula)\b/i.test(msg);
  return tieneNegocio && !esConsultaGeneral;
}

function requiereContacto(mensaje) {
  return /\b(extrae|extraer|busca|obtener|consigue|correo|email|contacto)\b/i.test(mensaje) &&
         /\b(correo|email|contacto|mail)\b/i.test(mensaje);
}

function extraerUrlDeMensaje(mensaje, historial) {
  // Buscar URL en el mensaje actual
  const urlMatch = mensaje.match(/https?:\/\/[^\s"]+/);
  if (urlMatch) return urlMatch[0];
  // Buscar en el historial reciente (últimos 6 mensajes)
  if (historial && historial.length > 0) {
    const recientes = historial.slice(-6).reverse();
    for (const h of recientes) {
      const text = h.parts?.[0]?.text || '';
      const match = text.match(/https?:\/\/[^\s"<]+/);
      if (match) return match[0];
    }
  }
  return null;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { mensaje, historial, systemPrompt } = await request.json();

    const usarPro = requiereMotorPro(mensaje);
    const apiKey = usarPro && env.GROQ_API_KEY_PRO ? env.GROQ_API_KEY_PRO : env.GROQ_API_KEY;
    const modelo = usarPro && env.GROQ_API_KEY_PRO ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant';
    // SIEMPRE usar LLaMA 3.3 cuando hay búsqueda local o contacto — nunca degradar
    const apiKeyFinal = requiereBusquedaLocal(mensaje) || requiereContacto(mensaje) ? (env.GROQ_API_KEY_PRO || env.GROQ_API_KEY) : apiKey;
    const modeloFinal = requiereBusquedaLocal(mensaje) || requiereContacto(mensaje) ? 'llama-3.3-70b-versatile' : modelo;

    console.log(`Motor: ${modeloFinal} | Pro: ${usarPro} | Forzado: ${requiereBusquedaLocal(mensaje) || requiereContacto(mensaje)}`);

    const groq = new Groq({ apiKey: apiKeyFinal });
    const tavilyClient = tavily({ apiKey: env.TAVILY_API_KEY });

    let searchContext = '';
    let lugaresContext = '';
    let busquedaRealizada = false;
    let contactoContext = '';

    // BUSQUEDA LOCAL CON APIFY — solo una vez
    if (requiereBusquedaLocal(mensaje)) {
      try {
        console.log(`Buscando lugares reales: "${mensaje}"`);

        const lugaresRes = await fetch(`${new URL(request.url).origin}/api/lugares`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: mensaje })
        });

        const lugaresData = await lugaresRes.json();
        busquedaRealizada = true;

        if (lugaresData.success && lugaresData.lugares && lugaresData.lugares.length > 0) {
          const { pez_gordo, interesante, descartar } = lugaresData.scoring || {};
          console.log(`Lugares: ${lugaresData.total_filtrado} | Pez Gordo: ${pez_gordo} | Interesante: ${interesante} | Descartar: ${descartar}`);

          lugaresContext = '\n\n⚠️ INSTRUCCION DE BLOQUEO ABSOLUTO: Los siguientes son los UNICOS datos reales devueltos por Google Maps. PROHIBIDO presentar cualquier negocio que no aparezca exactamente en esta lista.\n\nDATOS REALES de Google Maps con SCORING de prioridad. REGLAS OBLIGATORIAS:\n';
          lugaresContext += '1. USA SOLO ESTOS DATOS, NUNCA INVENTES NADA.\n';
          lugaresContext += '2. Si telefono es null escribe Sin telefono. Si sitio_web es null escribe Sin sitio web.\n';
          lugaresContext += '3. MUESTRA TODOS LOS NEGOCIOS SIN OMITIR NINGUNO, ordenados por score.\n';
          lugaresContext += '4. Muestra el emoji de prioridad (🐋 Pez Gordo / 🐟 Interesante / ⭕ Descartar) junto al nombre.\n';
          lugaresContext += '5. NO hagas busquedas adicionales.\n\n';

          lugaresContext += `RESUMEN: ${pez_gordo || 0} Pez Gordo 🐋 | ${interesante || 0} Interesante 🐟 | ${descartar || 0} Descartar ⭕\n\n`;

          lugaresData.lugares.forEach(l => {
            lugaresContext += `${l.numero}. ${l.prioridad} ${l.clasificacion} (${l.score}pts) — ${l.nombre}\n`;
            lugaresContext += `   Dir: ${l.direccion}\n`;
            lugaresContext += `   Tel: ${l.telefono ?? 'Sin telefono'}\n`;
            lugaresContext += `   Web: ${l.sitio_web ?? 'Sin sitio web'}\n`;
            lugaresContext += `   Rating: ${l.rating ?? 'N/D'} | Resenas: ${l.resenas ?? 'N/D'}\n\n`;
          });

          lugaresContext += `Total verificados en Panama: ${lugaresData.total_filtrado}\n`;
          console.log(`Contexto generado: ${lugaresContext.length} chars`);

        } else {
          lugaresContext = '\n\nBUSQUEDA LOCAL: No se encontraron resultados en Panama. Informa al usuario y sugiere otro termino.\n';
          console.log('Sin resultados:', lugaresData.error);
        }
      } catch (e) {
        console.log('Error buscando lugares:', e.message);
        lugaresContext = '\n\nBUSQUEDA LOCAL: Error tecnico al conectar con Google Maps.\n';
        busquedaRealizada = true;
      }
    }

    // EXTRACCION DE CORREO CON /api/contacto
    if (!busquedaRealizada && requiereContacto(mensaje)) {
      const urlEncontrada = extraerUrlDeMensaje(mensaje, historial);
      if (urlEncontrada) {
        try {
          console.log(`Extrayendo contacto de: ${urlEncontrada}`);
          const contactoRes = await fetch(`${new URL(request.url).origin}/api/contacto`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sitio_web: urlEncontrada, nombre: mensaje })
          });
          const contactoData = await contactoRes.json();
          busquedaRealizada = true;

          if (contactoData.success && contactoData.correo) {
            console.log(`Correo encontrado: ${contactoData.correo}`);
            const tieneWa = contactoData.whatsapp ? `\nWhatsApp: ${contactoData.whatsapp}` : '';
            contactoContext = `\n\n⚠️ DATO REAL EXTRAÍDO. USA SOLO ESTOS VALORES:\n`;
            contactoContext += `Correo: ${contactoData.correo}${tieneWa}\n`;
            contactoContext += `INSTRUCCION: Responde de forma natural. Ejemplo: "Encontré el correo de [negocio]: [correo]${contactoData.whatsapp ? ' y su WhatsApp: [wa]' : ''}". NO muestres campos técnicos como "Metodo" ni "Sitio web consultado".\n`;
          } else if (contactoData.metodo === 'background') {
            console.log(`Búsqueda en background iniciada para: ${urlEncontrada}`);
            contactoContext = `\n\nEXTRACCION DE CONTACTO:\n`;
            contactoContext += `INSTRUCCION: Informa al usuario: "No encontré correo en el HTML del sitio. Lancé una búsqueda profunda — te llegará el resultado por Telegram en aproximadamente 2 minutos."\n`;
          } else {
            console.log(`Sin correo para: ${urlEncontrada}`);
            contactoContext = `\n\n⚠️ DATO REAL EXTRAÍDO:\n`;
            contactoContext += `Correo: No disponible\n`;
            contactoContext += `INSTRUCCION: Informa de forma natural que no se encontró correo público. No inventes ni deduzcas correos.\n`;
          }
        } catch(e) {
          console.log('Error extrayendo contacto:', e.message);
          contactoContext = `\n\nEXTRACCION DE CONTACTO: Error técnico. Informa que no fue posible obtener el correo.\n`;
          busquedaRealizada = true;
        }
      }
    }

    // BUSQUEDA WEB CON TAVILY — solo si no hubo busqueda local
    // Tavily se activa para cualquier pregunta que requiera datos actuales o verificación
    const needsSearch = !busquedaRealizada && (
      /\b(hoy|actual|reciente|noticia|precio|clima|investiga|verifica|busca|buscar|encuentra|existe|disponible|nuevo|lanzó|salio|version|2024|2025|2026|quien es|que es|como esta|cuanto cuesta|cuanto vale|donde esta|cuando fue|es verdad|es cierto)\b/i.test(mensaje) ||
      mensaje.includes('?') && mensaje.length > 30  // cualquier pregunta larga probablemente necesita verificación
    );

    if (needsSearch) {
      console.log('🔍 Tavily activado para:', mensaje.substring(0, 60));
      try {
        const searchResult = await tavilyClient.search(mensaje, {
          maxResults: 5,
          searchDepth: usarPro ? 'advanced' : 'basic',
          includeAnswer: true
        });

        if (searchResult.answer) {
          searchContext = `\n\n⚠️ INFORMACION VERIFICADA DE INTERNET (fuente: Tavily):\n`;
          searchContext += `INSTRUCCION: Presenta esta información de forma natural y conversacional. NO uses formato de scoring (Pez Gordo/Interesante/Descartar). NO inventes datos adicionales. Solo usa lo que aparece aquí.\n\n`;
          searchContext += `${searchResult.answer}\n`;
        }
        if (searchResult.results?.length > 0) {
          searchContext += `\nFUENTES:\n`;
          searchResult.results.slice(0, usarPro ? 4 : 2).forEach(r => {
            searchContext += `- ${r.title}: ${r.content}\n`;
          });
        }
      } catch (e) {
        console.log('Tavily fallo:', e.message);
      }
    }

    // MENSAJES PARA GROQ — orden de prioridad del contexto
    let systemContent;
    if (lugaresContext) {
      // Búsqueda local: datos Google Maps primero, ancla después
      systemContent = lugaresContext + '\n\n' + (systemPrompt || 'Eres Kairos, agente de ventas experto en tiendas web para negocios en Panama.');
    } else if (searchContext) {
      // Búsqueda Tavily: datos reales primero — ancla simplificada sin scoring
      systemContent = searchContext + '\n\nEres Kairos, agente de ventas de TechZone Panama. Responde en español de forma natural y conversacional basándote UNICAMENTE en la información verificada de arriba. NO uses formato de scoring ni emojis de pez.';
    } else {
      // Conversación normal: ancla completa
      systemContent = (systemPrompt || 'Eres Kairos, agente de ventas experto en tiendas web para negocios en Panama.') + contactoContext;
    }

    const messages = [
      {
        role: 'system',
        content: systemContent
      }
    ];

    if (historial?.length > 0) {
      historial.forEach(h => {
        messages.push({
          role: h.role === 'model' ? 'assistant' : 'user',
          content: h.parts[0]?.text || ''
        });
      });
    }

    messages.push({ role: 'user', content: mensaje });

    const completion = await groq.chat.completions.create({
      model: modeloFinal,
      messages,
      temperature: (lugaresContext || contactoContext) ? 0.1 : (usarPro ? 0.3 : 0.7),
      max_tokens: usarPro ? 4096 : 2048,
      top_p: 0.95,
    });

    const respuesta = completion.choices[0]?.message?.content || 'Sin respuesta';

    return Response.json({ success: true, respuesta, motor: modelo });

  } catch (error) {
    console.error('Error en chat:', error.message);

    let mensajeUsuario = 'Lo siento, tuve un problema tecnico. Intentamos de nuevo?';
    if (error.message.includes('rate_limit') || error.message.includes('429')) {
      mensajeUsuario = 'Hemos alcanzado el limite de requests por hoy. Hagamos una pausa!';
    }

    return Response.json({ success: false, error: mensajeUsuario });
  }
}
// v3