// fix_detector_lote.js
const fs = require('fs');

const htmlPath = 'public/agente-ia.html';
let html = fs.readFileSync(htmlPath, 'utf8');

// Nueva función detectarYEnviarLote
const funcionLote = `
// ─── ENVÍO EN LOTE AUTOMÁTICO ───────────────────────────────
async function detectarYEnviarLote(respuesta) {
  try {
    const normalizada = respuesta
      .replace(/\\\\"/g, '"')
      .replace(/[""„‟]/g, '"')
      .replace(/[''‚\\u201a\\u201b]/g, "'");

    // Buscar JSON de lote en la respuesta
    const loteMatch = normalizada.match(/\\{[\\s\\S]*?"lote"\\s*:\\s*\\[[\\s\\S]*?\\][\\s\\S]*?\\}/);
    if (!loteMatch) return;

    let datos;
    try { datos = JSON.parse(loteMatch[0]); } catch(e) { return; }
    if (!datos.lote || !Array.isArray(datos.lote)) return;

    showToast('📧 Enviando ' + datos.lote.length + ' correos en lote...');

    const res = await fetch('/api/correo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(datos)
    });

    const data = await res.json();

    if (data.success) {
      showToast('✅ Lote completado: ' + data.enviados + ' enviados, ' + data.fallidos + ' fallidos');
      fetch('/api/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mensaje: '📧 <b>Envio en lote</b>\\n\\nEnviados: ' + data.enviados + '\\nFallidos: ' + data.fallidos })
      });
    } else {
      showToast('⚠ Error en lote: ' + (data.error || 'Error desconocido'));
    }
  } catch(e) { /* No era JSON de lote */ }
}
`;

// Agregar la función antes de detectarYEnviarCorreo
const ancla = '// ─── ENVÍO AUTOMÁTICO DE CORREOS ────────────────────────────';
if (!html.includes('detectarYEnviarLote')) {
  html = html.replace(ancla, funcionLote + '\n' + ancla);
  console.log('✅ Función detectarYEnviarLote agregada');
} else {
  console.log('ℹ️ Función ya existe');
}

// Agregar llamada a detectarYEnviarLote en sendMessage
const llamadaVieja = 'await detectarYEnviarCorreo(result.respuesta);';
const llamadaNueva = `await detectarYEnviarLote(result.respuesta);
    await detectarYEnviarCorreo(result.respuesta);`;

if (!html.includes('detectarYEnviarLote(result.respuesta)')) {
  html = html.replace(llamadaVieja, llamadaNueva);
  console.log('✅ Llamada a detectarYEnviarLote agregada en sendMessage');
} else {
  console.log('ℹ️ Llamada ya existe');
}

fs.writeFileSync(htmlPath + '.backup4', fs.readFileSync(htmlPath));
fs.writeFileSync(htmlPath, html);
console.log('✅ HTML actualizado correctamente');
console.log('');
console.log('Próximos pasos:');
console.log('  git add . && git commit -m "feat: detector JSON lote en HTML" && git push');
console.log('  npx wrangler pages deploy public --project-name=yesi-agente-ia --branch=production');