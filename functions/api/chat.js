import Groq from 'groq-sdk';
import { tavily } from '@tavily/core';

// Detectar si el mensaje requiere análisis complejo o búsqueda profunda
function requiereMotorPro(mensaje) {
  return /\b(busca|encuentra|analiza|investiga|prospectos|negocios|empresas|restaurantes|hoteles|ferreter|tiendas|agencias|correo|propuesta|redacta|elabora|compara|evalua)\b/i.test(mensaje);
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

    // Detectar si necesita búsqueda en internet
    const needsSearch = /\b(hoy|actual|reciente|noticia|precio|clima|busca|encuentra|investiga|negocios|empresas|restaurantes|hoteles|ferreter|tiendas|agencias)\b/i.test(mensaje);

    let searchContext = '';

    if (needsSearch) {
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

    // Formatear mensajes
    const messages = [
      {
        role: 'system',
        content: (systemPrompt || 'Eres Kairós, agente de ventas experto en tiendas web para negocios en Panamá.') + searchContext
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