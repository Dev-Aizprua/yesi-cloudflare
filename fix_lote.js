// fix_lote.js
const fs = require('fs');

const htmlPath = 'public/agente-ia.html';
let html = fs.readFileSync(htmlPath, 'utf8');

const viejo = 'const jsonMatches = normalizada.match(/\\{[^{}]*"nombre"[^{}]*\\}/g);';
const nuevo = `// Ignorar si es un JSON de lote o correo
    if (normalizada.includes('"lote":') || normalizada.includes('"plantilla_cuerpo":')) return;
    const jsonMatches = normalizada.match(/\\{[^{}]*"nombre"[^{}]*\\}/g);`;

if (!html.includes(viejo)) {
  console.error('❌ No se encontró el texto a reemplazar');
  process.exit(1);
}

html = html.replace(viejo, nuevo);
fs.writeFileSync(htmlPath + '.backup3', fs.readFileSync(htmlPath));
fs.writeFileSync(htmlPath, html);
console.log('✅ Condición anti-lote agregada correctamente');