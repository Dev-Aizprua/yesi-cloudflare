import Groq from 'groq-sdk';
import { tavily } from '@tavily/core';

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { mensaje, historial, systemPrompt } = await request.json();

    const groq = new Groq({ apiKey: env.GROQ_API_KEY });
    const tavilyClient = tavily({ apiKey: env.TAVILY_API_KEY });

    // Detectar si necesita búsqueda (palabras clave)
    const needsSearch = /\b(hoy|actual|reciente|noticia|precio|clima|qué pasó|cuándo|dónde está|último)\b/i.test(mensaje);

    let searchContext = '';

    if (needsSearch) {
      try {
        const searchResult = await tavilyClient.search(mensaje, {
          maxResults: 3,
          searchDepth: 'basic',
          includeAnswer: true
        });

        if (searchResult.answer) {
          searchContext = `\n\nINFORMACIÓN ACTUALIZADA DE INTERNET:\n${searchResult.answer}\n`;
        } else if (searchResult.results && searchResult.results.length > 0) {
          searchContext = `\n\nINFORMACIÓN ACTUALIZADA:\n`;
          searchResult.results.slice(0, 2).forEach(r => {
            searchContext += `- ${r.content}\n`;
          });
        }
      } catch (searchError) {
        console.log('Búsqueda Tavily falló, continúo sin ella:', searchError.message);
      }
    }

    // Formatear mensajes para Groq
    const messages = [
      {
        role: 'system',
        content: (systemPrompt || 'Eres Yesi, asistente técnica experta en IA, Cloudflare Workers y Google Sheets. Responde en español de forma concisa y técnica.') + searchContext
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

    // Agregar mensaje actual
    messages.push({ role: 'user', content: mensaje });

    // Llamar a Groq
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages,
      temperature: 0.7,
      max_tokens: 2048,
      top_p: 0.95,
    });

    const respuesta = completion.choices[0]?.message?.content || 'Sin respuesta';

    return Response.json({ success: true, respuesta });

  } catch (error) {
    console.error('Error en chat con Groq:', error.message);

    let mensajeUsuario = 'Lo siento, tuve un problema técnico. ¿Intentamos de nuevo?';

    if (error.message.includes('rate_limit') || error.message.includes('429')) {
      mensajeUsuario = 'Eduardo, hemos alcanzado el límite de Groq por hoy. ¡Hagamos una pausa!';
    }

    return Response.json({ success: false, error: mensajeUsuario });
  }
}
