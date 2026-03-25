export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { texto } = await request.json();

    if (!texto) {
      return Response.json({ success: false, error: 'Falta el texto' }, { status: 400 });
    }

    // Limpiar markdown del texto
    const textoLimpio = texto
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .replace(/#{1,6} /g, '')
      .replace(/\n+/g, ' ')
      .trim()
      .substring(0, 500); // Máximo 500 caracteres para ahorrar créditos

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: textoLimpio,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.3,
          use_speaker_boost: true
        }
      })
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      console.error('Error ElevenLabs:', JSON.stringify(error));
      return Response.json({ success: false, error: error.detail?.message || 'Error en ElevenLabs' }, { status: 500 });
    }

    // Devolver audio como base64
    const audioBuffer = await res.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(audioBuffer)));

    return Response.json({ success: true, audio: base64 });

  } catch (error) {
    console.error('Error en voz:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}