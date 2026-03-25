// fix_speaktext2.js
// node fix_speaktext2.js

const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, 'public', 'agente-ia.html');
let html = fs.readFileSync(htmlPath, 'utf8');

const start = html.indexOf('function speakText(btn, logIndex) {');
if (start === -1) { console.error('❌ No se encontró speakText'); process.exit(1); }

let depth = 0, end = start, encontrado = false;
for (let i = start; i < html.length; i++) {
  if (html[i] === '{') depth++;
  if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; encontrado = true; break; } }
}

if (!encontrado) { console.error('❌ No se encontró cierre de speakText'); process.exit(1); }
console.log('✅ Función encontrada');

const funcionNueva = `function speakText(btn, logIndex) {
  if (currentAudio && !currentAudio.paused) {
    currentAudio.pause();
    currentAudio = null;
    document.querySelectorAll('.tts-btn').forEach(b => { b.classList.remove('speaking'); b.textContent = '🔊 Escuchar'; });
    return;
  }
  if (window.speechSynthesis && window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    document.querySelectorAll('.tts-btn').forEach(b => { b.classList.remove('speaking'); b.textContent = '🔊 Escuchar'; });
    return;
  }

  const text = logs[logIndex] ? logs[logIndex].response : '';
  if (!text || text === '...') return;

  btn.classList.add('speaking');
  btn.textContent = '⏳ Generando...';

  fetch('/api/voz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texto: text })
  })
  .then(res => {
    if (!res.ok) throw new Error('Error ' + res.status);
    return res.blob();
  })
  .then(blob => {
    const audioUrl = URL.createObjectURL(blob);
    currentAudio = new Audio(audioUrl);
    btn.textContent = '⏹ Detener';
    currentAudio.onended = () => {
      btn.classList.remove('speaking');
      btn.textContent = '🔊 Escuchar';
      URL.revokeObjectURL(audioUrl);
      currentAudio = null;
    };
    currentAudio.play();
  })
  .catch(e => {
    showToast('⚠ ElevenLabs no disponible · Usando voz del navegador');
    btn.textContent = '⏹ Detener';
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-PA';
    utterance.rate = 0.95;
    utterance.pitch = 1;
    currentUtterance = utterance;
    utterance.onend = () => {
      btn.classList.remove('speaking');
      btn.textContent = '🔊 Escuchar';
      currentUtterance = null;
    };
    window.speechSynthesis.speak(utterance);
  });
}`;

const htmlNuevo = html.substring(0, start) + funcionNueva + html.substring(end);
fs.writeFileSync(htmlPath + '.backup2', html, 'utf8');
fs.writeFileSync(htmlPath, htmlNuevo, 'utf8');
console.log('✅ speakText actualizado para recibir audio como stream');
console.log('');
console.log('Próximos pasos:');
console.log('  1. Reemplaza functions/api/voz.js con el nuevo voz.js');
console.log('  2. git add . && git commit -m "fix: voz como stream, sin base64" && git push');
console.log('  3. npx wrangler pages deploy public --project-name=yesi-agente-ia --branch=production');