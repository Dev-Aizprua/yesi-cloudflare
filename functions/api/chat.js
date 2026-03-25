import Groq from 'groq-sdk';
import { tavily } from '@tavily/core';

// Detectar si el mensaje requiere análisis complejo o búsqueda profunda
function requiereMotorPro(mensaje) {
  return /\b(busca|encuentra|analiza|investiga|prospectos|negocios|empresas|restaurantes|hoteles|ferreter|tiendas|agencias|correo|propuesta|redacta|elabora|compara|evalua)\b/i.test(mensaje);
}

// Detectar si el mensaje es una búsqueda de negocios locales
function requiereBusquedaLocal(mensaje) {
  return /\b(busca|encuentra|dame|lista|muestra|hay|negocios|empresas|restaurantes|hoteles|ferreter|tiendas|agencias|farmacias|clinicas|gimnasios|bares|cafes|supermercados|bancos|peluquerias|spa|salon)\b/i.test(mensaje);
}

// Extraer el query de búsqueda del mensaje del usuario
function extraerQuery(mensaje) {
  // Remover palabras comunes de comando y quedarse con el tipo de negocio + zona
  return mensaje
    .replace(/^(busca|encuentra|dame|lista|muestra|hay)\s+/i, '')
    .replace(/\s+(en panamá|en panama|para mi|por favor|porfavor)$/i, '')
    .trim();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { mensaje, historial, systemPrompt } = await request.json();

    // Seleccionar motor según la tarea
    const usarPro = requiereMotorPro(mensaje);
    const apiKey = usarPro && env.GROQ_API_KEY_PRO ? env.GROQ_API_KEY_PRO : env.GROQ_API_KEY;
    const modelo = usarPro && env.GROQ_API_KEY_PRO ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant';

    console.log(`Motor: ${modelo} | Pro: ${usarPro}`);

    const groq = new Groq({ apiKey });
    const tavilyClient = tavily({ apiKey: env.TAVILY_API_KEY });

    let searchContext = '';
    let lugaresContext = '';

    // ─── BÚSQUEDA LOCAL CON APIFY (datos reales) ────────────────
    if (requiereBusquedaLocal(mensaje)) {
      try {
        const query = extraerQuery(mensaje);
        console.log(`Buscando lugares reales: "${query}"`);

        const lugaresRes = await fetch(`${new URL(request.url).origin}/api/lugares`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query })
        });

        const lugaresData = await lugaresRes.json();

        if (lugaresData.success && lugaresData.lugares && lugaresData.lugares.length > 0) {
          lugaresContext = '\n\nDAtos REALES de Google Maps (fuente: Apify). USA SOLO ESTOS DATOS, NO INVENTES NADA:\n';
          lugaresContext += 'REGLA CRÍTICA: Si telefono o sitio_web es null, di "Sin teléfono" o "Sin sitio web". NUNCA inventes datos.\n\n';

          lugaresData.lugares.forEach(l => {
            lugaresContext += `${l.numero}. ${l.nombre}\n`;
            lugaresContext += `   Dirección: ${l.direccion}\n`;
            lugaresContext += `   Teléfono: ${l.telefono !== null ? l.telefono : 'Sin teléfono'}\n`;
            lugaresContext += `   Web: ${l.sitio_web !== null ? l.sitio_web : 'Sin sitio web'}\n`;
            lugaresContext += `   Categoría: ${l.categoria}\n`;
            if (l.rating) lugaresContext += `   Rating: ${l.rating}/5 (${l.resenas || 0} reseñas)\n`;
            lugaresContext += '\n';
          });

          lugaresContext += `Total encontrados en Panamá: ${lugaresData.total_filtrado || lugaresData.lugares.length}\n`;
          console.log(`Lugares reales obtenidos: ${lugaresData.lugares.length}`);
        } else {
          lugaresContext = '\n\nBÚSQUEDA LOCAL: No se encontraron resultados verificados en Panamá para esta búsqueda. Informa al usuario que no hay resultados y sugiere intentar con otro término.\n';
          console.log('Sin resultados de lugares:', lugaresData.error);
        }
      } catch (lugaresError) {
        console.log('Error buscando lugares:', lugaresError.message);
        lugaresContext = '\n\nBÚSQUEDA LOCAL: Error al conectar con Google Maps. Informa al usuario del problema técnico.\n';
      }
    }

    // ─── BÚSQUEDA WEB CON TAVILY (verificación) ──────────────────
    const needsSearch = /\b(hoy|actual|reciente|noticia|precio|clima|investiga|verifica)\b/i.test(mensaje);

    if (needsSearch && !lugaresContext) {
      try {
        const searchResult = await tavilyClient.search(mensaje, {
          maxResults: 5,
          searchDepth: usarPro ? 'advanced' : 'basic',
          includeAnswer: true
        });

        if (searchResult.answer) {
          searchContext = `\n\nINFORMACIÓN VERIFICADA DE INTERNET:\n${searchResult.answer}\n`;
        }
        if (searchResult.results && searchResult.results.length > 0) {
          searchContext += `\nFUENTES ENCONTRADAS:\n`;
          searchResult.results.slice(0, usarPro ? 4 : 2).forEach(r => {
            searchContext += `- ${r.title}: ${r.content}\n`;
          });
        }
      } catch (searchError) {
        console.log('Búsqueda Tavily falló:', searchError.message);
      }
    }

    // ─── FORMATEAR MENSAJES PARA GROQ ────────────────────────────
    const messages = [
      {
        role: 'system',
        content: (systemPrompt || 'Eres Kairós, agente de ventas experto en tiendas web para negocios en Panamá.') + lugaresContext + searchContext
      }
    ];

    // Agregar historial
    if (historial && historial.length > 0) {
      historial.forEach(h => {
        messages.push({
          role: h.role === 'model' ? 'assistant' : 'user',
          content: h.parts[0]?.text || ''
        });
      });
    }

    messages.push({ role: 'user', content: mensaje });

    const completion = await groq.chat.completions.create({
      model: modelo,
      messages,
      temperature: usarPro ? 0.3 : 0.7,
      max_tokens: usarPro ? 4096 : 2048,
      top_p: 0.95,
    });

    const respuesta = completion.choices[0]?.message?.content || 'Sin respuesta';

    return Response.json({ success: true, respuesta, motor: modelo });

  } catch (error) {
    console.error('Error en chat:', error.message);

    let mensajeUsuario = 'Lo siento, tuve un problema técnico. ¿Intentamos de nuevo?';

    if (error.message.includes('rate_limit') || error.message.includes('429')) {
      mensajeUsuario = 'Hemos alcanzado el límite de requests por hoy. ¡Hagamos una pausa!';
    }

    return Response.json({ success: false, error: mensajeUsuario });
  }
}