export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { mensaje } = await request.json();

    if (!mensaje) {
      return Response.json({ success: false, error: 'Falta el mensaje' }, { status: 400 });
    }

    const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: mensaje,
        parse_mode: 'HTML'
      })
    });

    const data = await res.json();

    if (!data.ok) {
      console.error('Error Telegram:', JSON.stringify(data));
      return Response.json({ success: false, error: data.description }, { status: 500 });
    }

    return Response.json({ success: true });

  } catch (error) {
    console.error('Error en telegram:', error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}