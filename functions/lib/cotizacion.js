// functions/lib/cotizacion.js
// Arma una COTIZACIÓN a partir de lo que el usuario dictó por texto o voz
// ("hazme una cotización para Juan, 10 sillas a $25").
//
// Devuelve el MISMO objeto que construirDatosImportacion() (whatsapp.js) le
// arma a una foto — así la vista previa, el "sí / no / corregir" y el
// guardado (confirmarImportacion) se reusan tal cual, y el Excel y la
// imagen salen de excelCuadro.js/imagenCuadro.js SIN cambios.
//
// Principios de siempre:
//   - Groq solo EXTRAE lo que el usuario dijo (cantidad, precio, tasa). Todo
//     número lo calcula el código (calculo.js / tablaExtendida.js).
//   - Un dato que falta y es imprescindible (cantidad, precio) se PREGUNTA;
//     uno que no bloquea (cliente) queda pendiente en amarillo. Nunca se inventa.
//   - ITBMS: 7% por defecto. Otra tasa SOLO si el usuario la dijo. Solo se
//     aceptan las tasas conocidas (0 = exento, 7, 10, 15); cualquier otra se
//     pregunta en vez de aceptarse.
//   - Todas las líneas con la misma tasa → estructura idéntica a la de la
//     cotización probada por foto (pie "ITBMS (7%)"). Tasas mezcladas → se
//     agregan las columnas "ITBMS %" e "ITBMS B/." por línea y el pie suma.

import { calcularFila } from './calculo.js';
import { recalcularPie } from './tablaExtendida.js';

export const TASAS_ITBMS = [0, 7, 10, 15];
const TASA_POR_DEFECTO = 7;

// Mismo criterio que normalizarClave (whatsapp.js) y aClave (excelCuadro.js).
function aClave(texto) {
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_');
}

// "a 30 días" → "30 días". Solo se quita la "a" cuando va antes de un número; "a crédito" queda igual.
function limpiarCondicionPago(v) {
  return String(v ?? '').trim().replace(/^a\s+(?=\d)/i, '');
}

function redondear2(n) {
  return Math.round(n * 100) / 100;
}

// "$25", "B/. 25.50", "1,200" → número; cualquier otra cosa → null
function parsearNumero(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  const limpio = String(v).replace(/B\/\.?/gi, '').replace(/[$,\s]/g, '');
  return /^\d+(\.\d+)?$/.test(limpio) ? Number(limpio) : null;
}

// null/"" → 7 (por defecto); "exento"/"sin itbms" → 0; "10", "10%" → 10.
// Devuelve { tasa } o { invalida: texto } si no es una tasa conocida.
export function interpretarTasa(v) {
  if (v === null || v === undefined || String(v).trim() === '') return { tasa: TASA_POR_DEFECTO };
  if (typeof v === 'number') {
    return TASAS_ITBMS.includes(v) ? { tasa: v } : { invalida: String(v) };
  }
  const texto = String(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (/\b(exent[oa]|sin\s+(itbms|impuesto)|no\s+(paga|cobra|lleva)\s+(itbms|impuesto))\b/.test(texto)) return { tasa: 0 };
  const m = texto.match(/(\d+(?:\.\d+)?)/);
  if (!m) return { invalida: String(v) };
  const n = Number(m[1]);
  return TASAS_ITBMS.includes(n) ? { tasa: n } : { invalida: String(v) };
}

function fechaPanama(ahora = new Date()) {
  const p = new Date(ahora.getTime() - 5 * 3600 * 1000); // Panamá = UTC-5, sin horario de verano
  const dd = String(p.getUTCDate()).padStart(2, '0');
  const mm = String(p.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${p.getUTCFullYear()}`;
}

// Tipos de documento armados por texto/voz. Cada uno tiene su PROPIA numeración.
// La factura proforma NO es una factura fiscal: por eso lleva siempre un aviso visible.
export const AVISO_PROFORMA = 'Documento informativo — no constituye factura fiscal.';
const TIPOS_DOCUMENTO = {
  cotizacion: { prefijo: 'Cotización', etiquetaNumero: 'Cotización No.', nombre: 'cotización', regex: /^Cotizaci[oó]n\s+(\d+)/i },
  proforma: { prefijo: 'Factura proforma', etiquetaNumero: 'Factura proforma No.', nombre: 'factura proforma', regex: /^Factura\s+proforma\s+(\d+)/i },
};
function tipoDoc(tipo) {
  return TIPOS_DOCUMENTO[tipo] || TIPOS_DOCUMENTO.cotizacion;
}

/** Nombre corriente del documento ("cotización" / "factura proforma") para los mensajes al usuario. */
export function nombreDocumento(datos) {
  return tipoDoc(datos?.tipoDocumento).nombre;
}

/** Siguiente número consecutivo del tipo pedido, según los nombres de cuadro ya guardados ("Cotización 003 - Juan"). */
export function siguienteNumeroDocumento(nombresCuadros, tipo = 'cotizacion') {
  const { regex } = tipoDoc(tipo);
  let max = 0;
  for (const n of nombresCuadros || []) {
    const m = String(n).match(regex);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return String(max + 1).padStart(3, '0');
}

export function siguienteNumeroCotizacion(nombresCuadros) {
  return siguienteNumeroDocumento(nombresCuadros, 'cotizacion');
}

/**
 * @param {Object} args  lo que extrajo Groq: { cliente, lineas: [{descripcion, cantidad, precio, itbms}], validez }
 * @param {Object} opciones { membrete: {nombre,direccion,ruc}|null, numero: '001', ahora?: Date }
 * @returns {{ ok: true, datos: Object } | { ok: false, pregunta: string }}
 */
export function construirDatosCotizacion(args, opciones = {}) {
  const lineasCrudas = Array.isArray(args?.lineas) ? args.lineas : [];
  if (lineasCrudas.length === 0) {
    return { ok: false, pregunta: '¿Qué productos o servicios lleva la cotización? Dime la descripción, la cantidad y el precio de cada uno.' };
  }

  // 1) Validar cada línea. Falta cantidad o precio → se pregunta, nunca se inventa.
  const lineas = [];
  for (let i = 0; i < lineasCrudas.length; i++) {
    const l = lineasCrudas[i] || {};
    const descripcion = String(l.descripcion ?? '').trim();
    const cantidad = parsearNumero(l.cantidad);
    const precio = parsearNumero(l.precio);
    const nombre = descripcion || `la línea ${i + 1}`;
    if (!descripcion) return { ok: false, pregunta: `¿Qué es la línea ${i + 1} de la cotización?` };
    if (cantidad === null || cantidad <= 0) return { ok: false, pregunta: `¿Cuántas unidades de "${nombre}" lleva la cotización?` };
    if (precio === null || precio <= 0) return { ok: false, pregunta: `¿Cuál es el precio de "${nombre}"?` };
    const t = interpretarTasa(l.itbms);
    if (t.invalida !== undefined) {
      return { ok: false, pregunta: `No reconozco la tasa de ITBMS "${t.invalida}" para "${nombre}". Manejo 7%, 10% (licores), 15% (cigarrillos) o exento. ¿Cuál aplica?` };
    }
    lineas.push({ descripcion, cantidad, precio, tasa: t.tasa });
  }

  // 2) ¿Todas con la misma tasa, o mezcladas?
  const tasas = [...new Set(lineas.map(l => l.tasa))];
  const mezcladas = tasas.length > 1;
  const tasaUnica = tasas[0];

  const columnasBonitas = ['Ítem', 'Descripción', 'Cant.', 'Precio B/.', 'Total B/.'];
  const reglas = { total_b: 'cant * precio_b' };
  if (mezcladas) {
    columnasBonitas.push('ITBMS %', 'ITBMS B/.');
    reglas.itbms_b = 'total_b * itbms / 100'; // va DESPUÉS de total_b (orden de dependencia)
  }
  const columnasInternas = columnasBonitas.map(aClave);

  // 3) Filas: los números salen de calculo.js, no de Groq.
  const filas = lineas.map((l, i) => {
    const cruda = { item: i + 1, descripcion: l.descripcion, cant: l.cantidad, precio_b: l.precio };
    if (mezcladas) cruda.itbms = l.tasa;
    return calcularFila(cruda, reglas);
  });

  // 4) Pie: Subtotal → ITBMS → Total, con la misma forma que el de la foto.
  const fila = (etiqueta, clave, formula) => ({ etiqueta, clave, valor: null, formula, formulaOriginal: formula, pendiente: false });
  let pieBase;
  if (mezcladas) {
    pieBase = [
      fila('SUBTOTAL', 'subtotal', 'resumen_suma_total_b'),
      fila('ITBMS', 'itbms_total', 'resumen_suma_itbms_b'),
      fila('TOTAL', 'total', 'subtotal + itbms_total'),
    ];
  } else if (tasaUnica === 0) {
    pieBase = [
      fila('SUBTOTAL', 'subtotal', 'resumen_suma_total_b'),
      fila('TOTAL', 'total', 'subtotal'),
    ];
  } else {
    pieBase = [
      fila('SUBTOTAL', 'subtotal', 'resumen_suma_total_b'),
      fila(`ITBMS (${tasaUnica}%)`, `itbms_${tasaUnica}`, `subtotal * ${tasaUnica / 100}`),
      fila('TOTAL', 'total', `subtotal + itbms_${tasaUnica}`),
    ];
  }
  const pie = recalcularPie(pieBase, columnasInternas, filas);

  // 5) Encabezado: solo lo que se sabe. El cliente faltante queda pendiente (amarillo).
  const campo = (etiqueta, valor) => {
    const v = valor === null || valor === undefined ? '' : String(valor).trim();
    return { etiqueta, valor: v === '' ? null : v, pendiente: v === '' };
  };
  const membrete = opciones.membrete || null;
  const tipo = opciones.tipo === 'proforma' ? 'proforma' : 'cotizacion';
  const t = tipoDoc(tipo);
  const encabezado = [
    campo(t.etiquetaNumero, opciones.numero || '001'),
    campo('Fecha', fechaPanama(opciones.ahora)),
    campo('Cliente', args?.cliente),
  ];
  if (membrete?.nombre) encabezado.push(campo('Empresa', membrete.nombre));
  if (membrete?.ruc) encabezado.push(campo('RUC', membrete.ruc));
  if (membrete?.direccion) encabezado.push(campo('Dirección', membrete.direccion));
  if (tipo === 'cotizacion' && args?.validez && String(args.validez).trim()) encabezado.push(campo('Validez', args.validez));
  if (tipo === 'proforma' && args?.condicion_pago && String(args.condicion_pago).trim()) encabezado.push(campo('Condición de pago', limpiarCondicionPago(args.condicion_pago)));
  if (tipo === 'proforma' && opciones.referencia) encabezado.push(campo('Referencia', opciones.referencia));
  if (tipo === 'proforma') encabezado.push(campo('Aviso', AVISO_PROFORMA));

  const avisosPendientes = [];
  if (!encabezado[2].valor) avisosPendientes.push('Cliente no indicado — quedará vacío.');
  if (!membrete?.nombre) avisosPendientes.push(`Esta ${t.nombre} no lleva los datos de tu negocio porque todavía no los tengo.`);

  const cliente = encabezado[2].valor;
  return {
    ok: true,
    datos: {
      origen: 'texto',
      tipoDocumento: tipo,
      prefijo: t.prefijo,
      numero: opciones.numero || '001',
      // Lo ya validado de cada línea: permite reconstruir todo (columnas, filas y pie) al corregir
      fuente: { lineas: lineas.map(l => ({ descripcion: l.descripcion, cantidad: l.cantidad, precio: l.precio, itbms: l.tasa })) },
      nombreCuadro: `${t.prefijo} ${opciones.numero || '001'}${cliente ? ` - ${cliente}` : ''}`,
      subtitulo: null,
      columnasBonitas,
      columnasInternas,
      filas,
      filaTotales: null,
      reglas,
      validacion: { tieneFilaTotales: false },
      encabezado,
      pie,
      avisosPendientes,
    },
  };
}


// ══════════════════════════════════════════════════════════════════
// CORRECCIONES POR CHAT sobre un documento PENDIENTE (antes de confirmar)
// Cliente, fecha y demás datos del encabezado; y líneas por descripción
// (o por número). Groq solo EXTRAE qué campo y qué valor; aquí el código
// decide a qué línea corresponde, aplica y recalcula. Un campo calculado
// (Total, ITBMS B/.) no se edita: se recalcula solo.
// ══════════════════════════════════════════════════════════════════

// Datos del encabezado que se pueden AGREGAR aunque el documento no los traiga
const ENCABEZADO_AGREGABLES = ['Cliente', 'Fecha', 'Validez', 'Condición de pago', 'Teléfono', 'Email', 'Dirección', 'RUC'];

function claveDescripcion(datos) {
  const ks = datos.columnasInternas || [];
  if (ks.includes('descripcion')) return 'descripcion';
  const conTexto = ks.find(k => k && (datos.filas || []).length > 0 && datos.filas.every(f => typeof f[k] === 'string'));
  return conTexto || ks[0];
}

function esCalculada(datos, clave) {
  return Object.prototype.hasOwnProperty.call(datos.reglas || {}, clave);
}

// Columna a la que se refiere el usuario: coincidencia exacta o UN solo prefijo (cantidad ↔ cant)
function encontrarColumna(datos, campo) {
  const c = aClave(campo);
  const ks = (datos.columnasInternas || []).filter(k => k);
  if (ks.includes(c)) return c;
  const cand = ks.filter(k => k.length >= 3 && (k.startsWith(c) || c.startsWith(k)));
  return cand.length === 1 ? cand[0] : null;
}

/**
 * Lo que necesita Groq para extraer bien la corrección (todo tomado del documento).
 */
export function describirParaCorreccion(datos) {
  const ks = datos.columnasInternas || [];
  const editables = (datos.columnasBonitas || []).filter((_, i) => ks[i] && ks[i] !== 'item' && !esCalculada(datos, ks[i]));
  if (datos.origen === 'texto' && !editables.some(c => aClave(c) === 'itbms')) editables.push('ITBMS %');
  const kd = claveDescripcion(datos);
  return {
    etiquetas: (datos.encabezado || []).map(c => c.etiqueta).filter(e => !['aviso', 'referencia'].includes(aClave(e))),
    agregables: ENCABEZADO_AGREGABLES.filter(a => !(datos.encabezado || []).some(c => aClave(c.etiqueta) === aClave(a))),
    columnas: editables,
    descripciones: (datos.filas || []).map(f => String(f[kd] ?? '')),
  };
}

function ubicarLinea(datos, ref) {
  const filas = datos.filas || [];
  const texto = String(ref ?? '').trim();
  if (texto === '') {
    if (filas.length === 1) return { indice: 0 };
    return { mensaje: '¿A cuál línea te refieres? Dime la descripción o el número.' };
  }
  if (/^\d+$/.test(texto)) {
    const n = Number(texto);
    return n >= 1 && n <= filas.length ? { indice: n - 1 } : { mensaje: `La cotización tiene ${filas.length} línea(s); no existe la ${n}.` };
  }
  const kd = claveDescripcion(datos);
  const buscado = aClave(texto);
  const norm = f => aClave(String(f[kd] ?? ''));
  const exactas = filas.map((f, i) => (norm(f) === buscado ? i : -1)).filter(i => i >= 0);
  if (exactas.length === 1) return { indice: exactas[0] };
  const parciales = filas.map((f, i) => (norm(f).includes(buscado) || buscado.includes(norm(f)) ? i : -1)).filter(i => i >= 0 && norm(filas[i]) !== '');
  if (exactas.length === 0 && parciales.length === 1) return { indice: parciales[0] };
  const coinciden = exactas.length > 1 ? exactas : parciales;
  if (coinciden.length > 1) {
    return { mensaje: `Hay varias líneas parecidas a "${texto}": ${coinciden.map(i => `${i + 1}. ${filas[i][kd]}`).join('; ')}. ¿Cuál es? Dime su número.` };
  }
  return { mensaje: `No encontré "${texto}" en la lista. Las líneas son: ${filas.map((f, i) => `${i + 1}. ${f[kd]}`).join('; ')}.` };
}

/**
 * Aplica UNA corrección al documento pendiente.
 * @param {Object} datos  el pendiente (cotización por texto o factura leída de una foto)
 * @param {{objetivo: 'encabezado'|'linea'|null, campo: string|null, valor: any, linea?: any}} c  lo que extrajo Groq
 * @returns {{ok: true, datos: Object} | {ok: false, mensaje: string}}
 */
export function aplicarCorreccionDocumento(datos, c, ahora = new Date()) {
  const NO_ENTENDI = 'No entendí bien esa corrección. Dime por ejemplo: "el cliente es Juan Pérez", "la fecha es 30/09/2026", "las sillas son 12", "agrega 3 mesas a 80" o "quita las sillas".';
  if (!c || !c.objetivo) return { ok: false, mensaje: NO_ENTENDI };
  const d = JSON.parse(JSON.stringify(datos));

  // ── AGREGAR / QUITAR UNA LÍNEA (solo cotizaciones armadas por texto) ──
  if (c.objetivo === 'agregar_linea' || c.objetivo === 'quitar_linea') {
    if (d.origen !== 'texto' || !d.fuente?.lineas) {
      return { ok: false, mensaje: 'Agregar o quitar líneas por chat solo funciona en las cotizaciones que armo yo. En un documento leído de una foto, corrígelo en el Excel o mándame la foto de nuevo.' };
    }
    if (c.objetivo === 'agregar_linea') {
      if (!String(c.descripcion ?? '').trim()) {
        return { ok: false, mensaje: '¿Qué producto o servicio quieres agregar? Dime la descripción, la cantidad y el precio.' };
      }
      // Misma descripción y mismo precio (y misma tasa, o el usuario no dijo otra): se SUMA la
      // cantidad en la línea que ya existe, en vez de repetir la línea.
      const cantN = parsearNumero(c.cantidad);
      const precioN = parsearNumero(c.precio);
      const sinTasa = c.itbms === null || c.itbms === undefined || String(c.itbms).trim() === '';
      const tasaNueva = sinTasa ? null : interpretarTasa(c.itbms).tasa;
      const existente = d.fuente.lineas.find(l =>
        aClave(l.descripcion) === aClave(c.descripcion)
        && precioN !== null && parsearNumero(l.precio) === precioN
        && (sinTasa || interpretarTasa(l.itbms).tasa === tasaNueva));
      if (existente && cantN !== null && cantN > 0) existente.cantidad = redondear2(parsearNumero(existente.cantidad) + cantN);
      else d.fuente.lineas.push({ descripcion: c.descripcion, cantidad: c.cantidad, precio: c.precio, itbms: c.itbms });
    } else {
      const u = ubicarLinea(d, c.linea);
      if (u.mensaje) return { ok: false, mensaje: u.mensaje };
      if (d.fuente.lineas.length <= 1) {
        return { ok: false, mensaje: 'La cotización necesita al menos una línea. Si quieres empezar de nuevo, responde "no" y dime qué lleva.' };
      }
      d.fuente.lineas.splice(u.indice, 1);
    }
    const r = construirDatosCotizacion({ lineas: d.fuente.lineas }, { membrete: null, numero: d.numero, ahora });
    if (!r.ok) return { ok: false, mensaje: `${r.pregunta} Dímelo completo en un solo mensaje, por ejemplo: "agrega 3 mesas a 80".` };
    for (const k of ['columnasBonitas', 'columnasInternas', 'filas', 'reglas', 'pie', 'fuente']) d[k] = r.datos[k];
    return { ok: true, datos: d };
  }

  // Para cambiar un dato del encabezado o de una línea sí hacen falta campo y valor
  if (!c.campo || c.valor === null || c.valor === undefined || String(c.valor).trim() === '') {
    return { ok: false, mensaje: NO_ENTENDI };
  }
  const valor = String(c.valor).trim();

  // ── ENCABEZADO ────────────────────────────────────────────────
  if (c.objetivo === 'encabezado') {
    const campoN = aClave(c.campo);
    d.encabezado = d.encabezado || [];
    let campo = d.encabezado.find(e => aClave(e.etiqueta) === campoN);
    if (campo && /^cotizacion_no|^factura_proforma_no|^factura_no|^numero/.test(campoN)) {
      return { ok: false, mensaje: 'El número del documento se asigna solo, no se cambia por chat.' };
    }
    if (campoN === 'aviso') {
      return { ok: false, mensaje: 'Ese aviso es parte del documento y no se cambia.' };
    }
    if (campoN === 'referencia') {
      return { ok: false, mensaje: 'La referencia a la cotización de origen no se cambia por chat.' };
    }
    if (!campo) {
      const nombre = ENCABEZADO_AGREGABLES.find(a => aClave(a) === campoN);
      if (!nombre) {
        return { ok: false, mensaje: `No reconozco el dato "${c.campo}". Puedo cambiar: ${[...d.encabezado.map(e => e.etiqueta), ...describirParaCorreccion(datos).agregables].join(', ')}.` };
      }
      campo = { etiqueta: nombre, valor: null, pendiente: true };
      const iAviso = d.encabezado.findIndex(e => aClave(e.etiqueta) === 'aviso');
      if (iAviso >= 0) d.encabezado.splice(iAviso, 0, campo);
      else d.encabezado.push(campo);
    }
    let nuevo = campoN === 'condicion_de_pago' ? limpiarCondicionPago(valor) : valor;
    if (campoN === 'fecha') {
      if (aClave(valor) === 'hoy') nuevo = fechaPanama(ahora);
      else if (!/\d/.test(valor)) return { ok: false, mensaje: 'No entendí esa fecha. Dila así: "la fecha es 30/09/2026".' };
    }
    campo.valor = nuevo;
    campo.pendiente = false;
    d.avisosPendientes = (d.avisosPendientes || []).filter(a => !String(a).startsWith(`${campo.etiqueta} `));
    if (d.origen === 'texto') {
      const cliente = (d.encabezado.find(e => aClave(e.etiqueta) === 'cliente') || {}).valor;
      d.nombreCuadro = `${d.prefijo || 'Cotización'} ${d.numero || '001'}${cliente ? ` - ${cliente}` : ''}`;
    }
    return { ok: true, datos: d };
  }

  // ── LÍNEAS ────────────────────────────────────────────────────
  if (c.objetivo === 'linea') {
    const u = ubicarLinea(d, c.linea);
    if (u.mensaje) return { ok: false, mensaje: u.mensaje };
    const i = u.indice;
    const campoN = aClave(c.campo);
    const esTasa = ['itbms', 'tasa', 'tasa_itbms', 'impuesto'].includes(campoN);

    // Cotización por texto: se corrige la FUENTE y se reconstruye todo (columnas, filas y pie)
    if (d.origen === 'texto' && d.fuente?.lineas) {
      const l = d.fuente.lineas[i];
      if (esTasa) l.itbms = valor;
      else {
        const k = encontrarColumna(d, c.campo);
        if (!k || esCalculada(d, k) || k === 'item') {
          return { ok: false, mensaje: `"${c.campo}" no se cambia directo: el Total y el ITBMS se calculan solos. Dime la cantidad, el precio o la tasa de ITBMS.` };
        }
        if (k === 'descripcion') l.descripcion = valor;
        else if (k === 'cant') l.cantidad = valor;
        else if (k.startsWith('precio')) l.precio = valor;
        else return { ok: false, mensaje: `No sé cambiar "${c.campo}" en una cotización.` };
      }
      const r = construirDatosCotizacion({ lineas: d.fuente.lineas }, { membrete: null, numero: d.numero, ahora });
      if (!r.ok) return { ok: false, mensaje: `${r.pregunta} Dímelo completo en un solo mensaje, por ejemplo: "las sillas son 12".` };
      for (const k of ['columnasBonitas', 'columnasInternas', 'filas', 'reglas', 'pie', 'fuente']) d[k] = r.datos[k];
      return { ok: true, datos: d };
    }

    // Documento leído de una foto: se corrige la casilla y se recalcula
    if (esTasa) return { ok: false, mensaje: 'La tasa de ITBMS solo se cambia por chat en las cotizaciones que armo yo.' };
    const k = encontrarColumna(d, c.campo);
    if (!k || k === 'item') return { ok: false, mensaje: `No reconozco la columna "${c.campo}". Las columnas son: ${describirParaCorreccion(datos).columnas.join(', ')}.` };
    if (esCalculada(d, k)) return { ok: false, mensaje: `"${c.campo}" se calcula solo; dime el dato del que depende (por ejemplo la cantidad o el precio).` };
    const esTexto = k === claveDescripcion(d);
    const n = parsearNumero(valor);
    if (!esTexto && n === null) return { ok: false, mensaje: `"${valor}" no es un número válido para ${c.campo}.` };
    d.filas[i][k] = esTexto ? valor : n;
    d.filas[i] = calcularFila(d.filas[i], d.reglas || {});
    if ((d.pie || []).length > 0) d.pie = recalcularPie(d.pie, d.columnasInternas, d.filas);
    return { ok: true, datos: d };
  }

  return { ok: false, mensaje: NO_ENTENDI };
}

/**
 * Cómo interpretar la respuesta del usuario a un pendiente.
 * "no" SOLO descarta si es un "no" a secas (o "no gracias"): "no, el cliente es Juan"
 * es una corrección, no una cancelación.
 * @returns {'confirmar'|'descartar'|'corregir'}
 */
export function clasificarRespuestaPendiente(texto) {
  const palabras = aClave(String(texto || '').trim()).split('_').filter(Boolean);
  const primera = palabras[0] || '';
  if (['si', 'confirmo', 'confirmar', 'confirma', 'dale', 'ok', 'correcto'].includes(primera)) return 'confirmar';
  if (['cancela', 'cancelar', 'descarta', 'descartar'].includes(primera)) return 'descartar';
  if (primera === 'no' && palabras.length <= 2) return 'descartar';
  return 'corregir';
}


// ══════════════════════════════════════════════════════════════════
// CONVERTIR UNA COTIZACIÓN GUARDADA EN FACTURA PROFORMA
// La factura proforma NO depende de la cotización: aquí solo se COPIAN
// cliente, líneas y tasas a un documento nuevo (su propio número, su
// propia fecha), que se arma con el mismo motor que "desde cero".
// ══════════════════════════════════════════════════════════════════

/**
 * Elige la cotización guardada a la que se refiere el usuario.
 * Acepta el número ("004", "4", "Cotización 004"), el nombre completo, o "la última".
 * @param {Array<{nombre_cuadro: string}>} cuadros  todos los cuadros del negocio
 * @param {string|null} referencia  lo que dijo el usuario
 * @returns {{cuadro: Object} | {mensaje: string}}
 */
export function elegirCotizacion(cuadros, referencia) {
  const { regex } = TIPOS_DOCUMENTO.cotizacion;
  const cotizaciones = (cuadros || [])
    .map(c => ({ c, m: String(c.nombre_cuadro || '').match(regex) }))
    .filter(x => x.m)
    .map(x => ({ cuadro: x.c, numero: Number(x.m[1]) }));

  if (cotizaciones.length === 0) return { mensaje: 'Todavía no tienes cotizaciones guardadas. Puedo armarte la factura proforma desde cero: dime el cliente y qué lleva.' };

  const lista = cotizaciones.map(x => `"${x.cuadro.nombre_cuadro}"`).join(', ');
  const ref = String(referencia ?? '').trim();

  if (ref === '') {
    if (cotizaciones.length === 1) return { cuadro: cotizaciones[0].cuadro };
    return { mensaje: `¿De cuál cotización? Tienes: ${lista}.` };
  }
  if (/ultim/.test(aClave(ref))) {
    return { cuadro: cotizaciones.reduce((a, b) => (b.numero > a.numero ? b : a)).cuadro };
  }
  const exacta = cotizaciones.find(x => aClave(x.cuadro.nombre_cuadro) === aClave(ref));
  if (exacta) return { cuadro: exacta.cuadro };
  const n = ref.match(/(\d+)/);
  if (n) {
    const coinciden = cotizaciones.filter(x => x.numero === Number(n[1]));
    if (coinciden.length === 1) return { cuadro: coinciden[0].cuadro };
  }
  return { mensaje: `No encontré la cotización "${ref}". Tienes: ${lista}.` };
}

/**
 * Saca de una cotización guardada lo que se copia a la factura proforma.
 * @param {{nombre_cuadro: string, estructura: Object, filas: Object[]}} cuadro  ya con el JSON leído
 * @returns {{ok: true, cliente: string|null, lineas: Object[], referencia: string} | {ok: false, mensaje: string}}
 */
export function lineasDesdeCuadro(cuadro) {
  const filas = Array.isArray(cuadro?.filas) ? cuadro.filas : [];
  const est = cuadro?.estructura || {};
  const nombre = String(cuadro?.nombre_cuadro || '');
  const NO_SE_PUEDE = `No puedo convertir "${nombre}" automáticamente porque no la armé yo (la leí de una foto o está incompleta). Dime el cliente y qué lleva, y te hago la factura proforma desde cero.`;

  const validas = filas.length > 0 && filas.every(f =>
    f && typeof f.descripcion === 'string' && typeof f.cant === 'number' && typeof f.precio_b === 'number');
  if (!validas) return { ok: false, mensaje: NO_SE_PUEDE };

  // Tasa: la de cada línea si la cotización tenía tasas mezcladas; si no, la del pie
  // ("ITBMS (10%)"), y si el pie no tiene ITBMS, todo estaba exento.
  let tasaDelPie = 0;
  const filaItbms = (est.pie || []).find(p => aClave(p.etiqueta).startsWith('itbms'));
  if (filaItbms) {
    const m = String(filaItbms.etiqueta).match(/\((\d+(?:\.\d+)?)\s*%\)/);
    if (!m) {
      if (!filas.every(f => typeof f.itbms === 'number')) return { ok: false, mensaje: NO_SE_PUEDE };
    } else tasaDelPie = Number(m[1]);
  }
  const lineas = filas.map(f => ({
    descripcion: f.descripcion,
    cantidad: f.cant,
    precio: f.precio_b,
    itbms: typeof f.itbms === 'number' ? f.itbms : tasaDelPie,
  }));

  const cliente = ((est.encabezado || []).find(e => aClave(e.etiqueta) === 'cliente') || {}).valor ?? null;
  const ref = nombre.match(/^(Cotizaci[oó]n\s+\d+)/i);
  return { ok: true, cliente: cliente || null, lineas, referencia: ref ? ref[1].replace(/\s+/g, ' ') : nombre };
}


/**
 * Busca un documento guardado (cotización o factura proforma) por lo que dijo el usuario:
 * "004", "Cotización 004", "la factura proforma 3"... Devuelve el cuadro o null si no hay
 * UNA coincidencia clara (si el mismo número existe en los dos tipos y el usuario no dijo
 * cuál, devuelve null para que se le pregunte, en vez de adivinar).
 * @param {Array<{nombre_cuadro: string}>} cuadros
 * @param {string|null} referencia
 */
export function buscarDocumentoGuardado(cuadros, referencia) {
  const ref = String(referencia ?? '').trim();
  if (!ref) return null;
  const refN = aClave(ref);
  const tipos = /proforma|factura/.test(refN) ? ['proforma'] : /cotiz/.test(refN) ? ['cotizacion'] : ['cotizacion', 'proforma'];
  const candidatos = [];
  for (const t of tipos) {
    for (const c of cuadros || []) {
      const m = String(c.nombre_cuadro || '').match(TIPOS_DOCUMENTO[t].regex);
      if (m) candidatos.push({ c, n: Number(m[1]) });
    }
  }
  if (candidatos.length === 0) return null;
  if (/ultim/.test(refN)) {
    if (tipos.length > 1) return null; // "la última" a secas: no se sabe de cuál tipo
    return candidatos.reduce((a, b) => (b.n > a.n ? b : a)).c;
  }
  const exactas = candidatos.filter(x => aClave(x.c.nombre_cuadro) === refN);
  if (exactas.length === 1) return exactas[0].c;
  const num = ref.match(/(\d+)/);
  if (num) {
    const coinciden = candidatos.filter(x => x.n === Number(num[1]));
    if (coinciden.length === 1) return coinciden[0].c;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════
// ÍNDICE DE DOCUMENTOS (fase 1a): la fila que va a la tabla `documentos`.
// Función PURA (no toca la base): sirve igual al confirmar un documento nuevo
// y para indexar los ya guardados. Los números NO se calculan aquí: se leen
// del pie que ya calculó el código (recalcularPie). Dato dudoso = NO se
// inventa: queda null y la fila se marca revisar = 1.
// ══════════════════════════════════════════════════════════════════

// "30/09/2026" → "2026-09-30"; cualquier otra cosa o fecha inexistente → null
function fechaIsoDesdeTexto(texto) {
  const m = String(texto ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [d, mes, a] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const f = new Date(Date.UTC(a, mes - 1, d));
  if (f.getUTCFullYear() !== a || f.getUTCMonth() !== mes - 1 || f.getUTCDate() !== d) return null;
  return `${a}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function numeroFinito(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * @param {{ nombreCuadro: string, estructura: Object, tipo?: 'cotizacion'|'proforma' }} cuadro
 *   `tipo` es opcional: si no viene se deduce del nombre ("Factura proforma 004 - Juan").
 * @returns {null | { tipo, numero, cliente, fecha, subtotal, itbms, total, revisar, referenciaNumero }}
 *   null = no es una cotización/proforma armada por el bot (p. ej. una factura leída de foto).
 */
export function filaIndiceDocumento(cuadro) {
  const nombre = String(cuadro?.nombreCuadro ?? '');
  const est = cuadro?.estructura || {};

  let tipo = cuadro?.tipo;
  if (tipo !== undefined && !TIPOS_DOCUMENTO[tipo]) return null;
  if (!tipo) tipo = ['cotizacion', 'proforma'].find(t => TIPOS_DOCUMENTO[t].regex.test(nombre));
  if (!tipo) return null;
  const m = nombre.match(TIPOS_DOCUMENTO[tipo].regex);
  if (!m) return null;
  const numero = m[1];

  const campo = etiqueta => ((est.encabezado || []).find(e => aClave(e.etiqueta) === etiqueta) || {}).valor ?? null;
  const pie = clave => numeroFinito(((est.pie || []).find(p => p.clave === clave) || {}).valor);

  const clienteTxt = campo('cliente');
  const cliente = clienteTxt && String(clienteTxt).trim() ? String(clienteTxt).trim() : null;
  const fecha = fechaIsoDesdeTexto(campo('fecha'));
  const subtotal = pie('subtotal');
  const total = pie('total');
  // ITBMS = Total − Subtotal: sirve igual con tasa única, tasas mezcladas o exento
  // (la clave del pie cambia: itbms_7, itbms_total, ninguna).
  const itbms = subtotal !== null && total !== null ? redondear2(total - subtotal) : null;

  let referenciaNumero = null;
  if (tipo === 'proforma') {
    const r = String(campo('referencia') ?? '').match(TIPOS_DOCUMENTO.cotizacion.regex);
    if (r) referenciaNumero = r[1];
  }

  const revisar = cliente === null || fecha === null || subtotal === null || total === null ? 1 : 0;
  return { tipo, numero, cliente, fecha, subtotal, itbms, total, revisar, referenciaNumero };
}