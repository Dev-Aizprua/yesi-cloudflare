import Groq from 'groq-sdk';
import { tavily } from '@tavily/core';

function requiereMotorPro(mensaje) {
  return /\b(busca|encuentra|analiza|investiga|prospectos|negocios|empresas|restaurantes|hoteles|ferreter|tiendas|agencias|correo|propuesta|redacta|elabora|compara|evalua)\b/i.test(mensaje);
}

function requiereBusquedaLocal(mensaje) {
  return /\b(busca|encuentra|dame|lista|muestra|hay|negocios|empresas|restaurantes|hoteles|ferreter|tiendas|agencias|farmacias|clinicas|gimnasios|bares|cafes|supermercados|bancos|peluquerias|spa|salon)\b/i.test(mensaje);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { mensaje, historial, systemPrompt } = await request.json();

    const usarPro = requiereMotorPro(mensaje);
    const apiKey = usarPro && env.GROQ_API_KEY_PRO ? env.GROQ_API_KEY_PRO : env.GROQ_API_KEY;
    const modelo = usarPro && env.GROQ_API_KEY_PRO ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant';

    console.log(`Motor: ${modelo} | Pro: ${usarPro}`);

    const groq = new Groq({ apiKey });
    const tavilyClient = tavily({ apiKey: env.TAVILY_API_KEY });

    let searchContext = '';
    let lugaresContext = '';
    let busquedaRealizada = false;

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
          console.log(`Lugares reales obtenidos: ${lugaresData.lugares.length} | Con correo: ${lugaresData.con_correo || 0}`);

          lugaresContext = '\n\nDATOS REALES de Google Maps. REGLAS OBLIGATORIAS:\n';
          lugaresContext += '1. USA SOLO ESTOS DATOS, NUNCA INVENTES NADA.\n';
          lugaresContext += '2. Si telefono es null escribe Sin telefono. Si sitio_web es null escribe Sin sitio web. Si correo es null escribe Sin correo.\n';
          lugaresContext += '3. MUESTRA TODOS LOS NEGOCIOS DE LA LISTA SIN OMITIR NINGUNO.\n';
          lugaresContext += '4. NO hagas busquedas adicionales. Usa solo estos datos.\n\n';

          lugaresData.lugares.forEach(l => {
            lugaresContext += `${l.numero}. ${l.nombre}\n`;
            lugaresContext += `   Dir: ${l.direccion}\n`;
            lugaresContext += `   Tel: ${l.telefono ?? 'Sin telefono'}\n`;
            lugaresContext += `   Web: ${l.sitio_web ?? 'Sin sitio web'}\n`;
            lugaresContext += `   Correo: ${l.correo ?? 'Sin correo'}\n`;
            lugaresContext += `   Rating: ${l.rating ?? 'N/D'} | Resenas: ${l.resenas ?? 'N/D'}\n\n`;
          });

          lugaresContext += `Total: ${lugaresData.total_filtrado} negocios verificados en Panama.\n`;
          lugaresContext += `Con correo encontrado: ${lugaresData.con_correo || 0}\n`;
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

    // BUSQUEDA WEB CON TAVILY — solo si no hubo busqueda local
    const needsSearch = !busquedaRealizada && /\b(hoy|actual|reciente|noticia|precio|clima|investiga|verifica)\b/i.test(mensaje);

    if (needsSearch) {
      try {
        const searchResult = await tavilyClient.search(mensaje, {
          maxResults: 5,
          searchDepth: usarPro ? 'advanced' : 'basic',
          includeAnswer: true
        });

        if (searchResult.answer) {
          searchContext = `\n\nINFORMACION VERIFICADA DE INTERNET:\n${searchResult.answer}\n`;
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

    // MENSAJES PARA GROQ
    const messages = [
      {
        role: 'system',
        content: (systemPrompt || 'Eres Kairos, agente de ventas experto en tiendas web para negocios en Panama.') + lugaresContext + searchContext
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

    let mensajeUsuario = 'Lo siento, tuve un problema tecnico. Intentamos de nuevo?';
    if (error.message.includes('rate_limit') || error.message.includes('429')) {
      mensajeUsuario = 'Hemos alcanzado el limite de requests por hoy. Hagamos una pausa!';
    }

    return Response.json({ success: false, error: mensajeUsuario });
  }
}