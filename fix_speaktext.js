// fix_speaktext.js
// Ejecutar desde la raíz del proyecto:
// node fix_speaktext.js

const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, 'public', 'agente-ia.html');
let html = fs.readFileSync(htmlPath, 'utf8');

// Encontrar la función speakText completa
const start = html.indexOf('function speakText(btn, logIndex) {');
if (start === -1) {
  console.error('❌ No se encontró function speakText');
  process.exit(1);
}

// Encontrar el cierre de la función contando llaves
let depth = 0;
let end = start;
let encontrado = false;
for (let i = start; i < html.length; i++) {
  if (html[i] === '{') depth++;
  if (html[i] === '}') {
    depth--;
    if (depth === 0) {
      end = i + 1;
      encontrado = true;
      break;
    }
  }
}

if (!encontrado) {
  console.error('❌ No se encontró el cierre de speakText');
  process.exit(1);
}

const funcionVieja = html.substring(start, end);
console.log('✅ Función encontrada, longitud:', funcionVieja.length, 'chars');

// Nueva función con ElevenLabs + fallback Web Speech
const funcionNueva = `function speakText(btn, logIndex) {
  // Detener si ya está reproduciendo
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
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      // ElevenLabs OK
      const audioBlob = new Blob([Uint8Array.from(atob(data.audio), c => c.charCodeAt(0))], { type: 'audio/mpeg' });
      const audioUrl = URL.createObjectURL(audioBlob);
      currentAudio = new Audio(audioUrl);
      btn.textContent = '⏹ Detener';
      currentAudio.onended = () => {
        btn.classList.remove('speaking');
        btn.textContent = '🔊 Escuchar';
        URL.revokeObjectURL(audioUrl);
        currentAudio = null;
      };
      currentAudio.play();
    } else {
      throw new Error(data.error || 'ElevenLabs no disponible');
    }
  })
  .catch(e => {
    // Fallback: Web Speech API
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

// Hacer el reemplazo
const htmlNuevo = html.substring(0, start) + funcionNueva + html.substring(end);

// Backup
fs.writeFileSync(htmlPath + '.backup', html, 'utf8');
console.log('✅ Backup guardado: agente-ia.html.backup');

// Guardar
fs.writeFileSync(htmlPath, htmlNuevo, 'utf8');
console.log('✅ speakText actualizado a ElevenLabs con fallback Web Speech');
console.log('');
console.log('Próximos pasos:');
console.log('  git add . && git commit -m "feat: voz ElevenLabs en speakText" && git push');
console.log('  npx wrangler pages deploy public --project-name=yesi-agente-ia --branch=production');