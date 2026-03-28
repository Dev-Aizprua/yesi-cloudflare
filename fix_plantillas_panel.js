// fix_plantillas_panel.js
const fs = require('fs');

const htmlPath = 'public/panel.html';
let html = fs.readFileSync(htmlPath, 'utf8');

// 1. Reemplazar el modal de campaña con versión que incluye selector de plantillas
const modalViejo = `<!-- MODAL CAMPAÑA -->
<div class="modal-overlay" id="modalCampana">
  <div class="modal">
    <div class="modal-header">
      <span class="modal-title">🚀 Campaña de Ventas</span>
      <button class="modal-close" onclick="cerrarModal('modalCampana')">✕</button>
    </div>
    <div class="modal-body">
      <div style="background:rgba(46,204,113,0.06);border:1px solid rgba(46,204,113,0.2);border-radius:4px;padding:12px;margin-bottom:16px;font-size:10px;color:var(--text-dim);">
        <span id="campanaResumen"></span>
      </div>
      <div class="field">
        <label>Asunto (usa {nombre} y {rubro})</label>
        <input type="text" id="campana-asunto" value="Propuesta de Tienda Web para {nombre}" />
      </div>
      <div class="field">
        <label>Cuerpo del mensaje (usa {nombre} y {rubro})</label>
        <textarea id="campana-cuerpo">Estimado(a) {nombre},

Me comunico de parte de TechZone Panama para presentarle una propuesta personalizada para su negocio en el sector de {rubro}.

Contamos con soluciones de tiendas web profesionales que le permitiran aumentar sus ventas y llegar a mas clientes en Panama.

Le gustaria agendar una llamada para contarle mas detalles?

Quedo a su disposicion.

Atentamente,
Eduardo Aizprua
TechZone Panama</textarea>
      </div>
      <div style="font-size:9px;color:var(--accent3);margin-top:8px;">
        ⚡ Anti-Spam Throttling activo: delay de 5-10s entre correos para maxima entregabilidad
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-cancel" onclick="cerrarModal('modalCampana')">Cancelar</button>
      <button class="btn btn-primary" id="btnLanzar" onclick="ejecutarCampana()">🚀 Lanzar Campaña</button>
    </div>
  </div>
</div>`;

const modalNuevo = `<!-- MODAL CAMPAÑA -->
<div class="modal-overlay" id="modalCampana">
  <div class="modal">
    <div class="modal-header">
      <span class="modal-title">🚀 Campaña de Ventas</span>
      <button class="modal-close" onclick="cerrarModal('modalCampana')">✕</button>
    </div>
    <div class="modal-body">
      <div style="background:rgba(46,204,113,0.06);border:1px solid rgba(46,204,113,0.2);border-radius:4px;padding:12px;margin-bottom:16px;font-size:10px;color:var(--text-dim);">
        <span id="campanaResumen"></span>
      </div>
      <div class="field">
        <label>Plantilla de correo</label>
        <select id="campana-plantilla" onchange="cargarPlantilla()">
          <option value="">✍️ Personalizada (editar manualmente)</option>
          <option value="restaurante">🍕 Restaurante / Comida</option>
          <option value="odontologia">🦷 Clínica / Odontología</option>
          <option value="retail">🛍️ Tienda / Retail</option>
          <option value="servicios_profesionales">⚖️ Servicios Profesionales</option>
          <option value="multiservicios">✨ Multiservicios / Otros</option>
        </select>
      </div>
      <div class="field">
        <label>Asunto (usa {nombre} y {rubro})</label>
        <input type="text" id="campana-asunto" value="Propuesta de Tienda Web para {nombre}" />
      </div>
      <div class="field">
        <label>Cuerpo del mensaje (usa {nombre} y {rubro})</label>
        <textarea id="campana-cuerpo" style="min-height:180px;">Estimado(a) {nombre},

Me comunico de parte de TechZone Panama para presentarle una propuesta personalizada para su negocio en el sector de {rubro}.

Contamos con soluciones de tiendas web profesionales que le permitiran aumentar sus ventas y llegar a mas clientes en Panama.

Le gustaria agendar una llamada para contarle mas detalles?

Quedo a su disposicion.

Atentamente,
Eduardo Aizprua
TechZone Panama</textarea>
      </div>
      <div style="font-size:9px;color:var(--accent3);margin-top:8px;">
        ⚡ Anti-Spam Throttling activo: delay de 5-10s entre correos para maxima entregabilidad
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-cancel" onclick="cerrarModal('modalCampana')">Cancelar</button>
      <button class="btn btn-primary" id="btnLanzar" onclick="ejecutarCampana()">🚀 Lanzar Campaña</button>
    </div>
  </div>
</div>`;

if (!html.includes('<!-- MODAL CAMPAÑA -->')) {
  console.error('❌ No se encontró el modal de campaña');
  process.exit(1);
}

html = html.replace(modalViejo, modalNuevo);
console.log('✅ Modal de campaña actualizado con selector de plantillas');

// 2. Agregar función cargarPlantilla() antes del cierre de </script>
const funcionPlantilla = `
// ─── PLANTILLAS ──────────────────────────────────────────────────
async function cargarPlantilla() {
  const key = document.getElementById('campana-plantilla').value;
  if (!key) return; // Plantilla personalizada — no tocar

  try {
    const res = await fetch('/api/plantillas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, nombre: '{nombre}', rubro: '{rubro}' })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('campana-asunto').value = data.asunto;
      document.getElementById('campana-cuerpo').value = data.cuerpo;
      showToast(data.icono + ' Plantilla ' + data.rubro + ' cargada');
    }
  } catch(e) {
    showToast('⚠ Error cargando plantilla');
  }
}

// Cargar plantilla automatica en modal individual segun rubro del prospecto
async function cargarPlantillaIndividual(rubro, nombre) {
  if (!rubro) return;
  try {
    const res = await fetch('/api/plantillas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rubro, nombre })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('correo-asunto').value = data.asunto;
      document.getElementById('correo-cuerpo').value = data.cuerpo;
    }
  } catch(e) { /* silencioso */ }
}
`;

html = html.replace('</script>', funcionPlantilla + '\n</script>');
console.log('✅ Función cargarPlantilla() agregada');

// 3. Actualizar abrirModalCorreo para cargar plantilla automáticamente
const correoViejoFn = `  document.getElementById('correo-asunto').value = \`Propuesta de Tienda Web para \${p.empresa || p.nombre}\`;
  document.getElementById('correo-cuerpo').value =
\`Estimado(a) \${p.nombre},

Me comunico de parte de TechZone Panama para presentarle una propuesta personalizada para su negocio\${p.rubro ? ' en el sector ' + p.rubro : ''}.

Contamos con soluciones de tiendas web profesionales que le permitiran aumentar sus ventas y llegar a mas clientes en Panama.

Le gustaria agendar una llamada para contarle mas detalles?

Quedo a su disposicion.

Atentamente,
Eduardo Aizprua
TechZone Panama\`;
  abrirModal('modalCorreo');`;

const correoNuevoFn = `  document.getElementById('correo-asunto').value = \`Propuesta de Tienda Web para \${p.empresa || p.nombre}\`;
  document.getElementById('correo-cuerpo').value =
\`Estimado(a) \${p.nombre},

Me comunico de parte de TechZone Panama para presentarle una propuesta personalizada para su negocio\${p.rubro ? ' en el sector ' + p.rubro : ''}.

Contamos con soluciones de tiendas web profesionales que le permitiran aumentar sus ventas y llegar a mas clientes en Panama.

Le gustaria agendar una llamada para contarle mas detalles?

Quedo a su disposicion.

Atentamente,
Eduardo Aizprua
TechZone Panama\`;
  abrirModal('modalCorreo');
  // Cargar plantilla automatica segun rubro
  cargarPlantillaIndividual(p.rubro, p.nombre);`;

if (html.includes(correoViejoFn)) {
  html = html.replace(correoViejoFn, correoNuevoFn);
  console.log('✅ Modal individual actualizado con plantilla automática');
} else {
  console.log('⚠ No se encontró el texto exacto del modal individual — revisar manualmente');
}

// Guardar
fs.writeFileSync(htmlPath + '.backup5', fs.readFileSync(htmlPath));
fs.writeFileSync(htmlPath, html);
console.log('✅ panel.html actualizado correctamente');
console.log('');
console.log('Próximos pasos:');
console.log('  git add . && git commit -m "feat: selector de plantillas en panel" && git push');
console.log('  npx wrangler pages deploy public --project-name=yesi-agente-ia --branch=production');