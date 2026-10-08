// functions/lib/pagos.js
// Lógica PURA del registro de pagos (sin base de datos, sin WhatsApp): interpretar
// monto y fecha, calcular saldos, repartir un pago y armar los mensajes.
// Principios: Groq solo EXTRAE valores crudos (cliente, monto, número, fecha);
// todo lo demás lo decide este código. Nada se aplica solo: siempre hay vista
// previa con el efecto y confirmación explícita del usuario.

const EPS = 0.005;

export function redondear2(n) {
  return Math.round(n * 100) / 100;
}

function sinTildes(t) {
  return String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export function formatoMonto(n) {
  return `B/. ${redondear2(n).toFixed(2)}`;
}

// "100", "$100", "B/. 1,200.50" → número > 0; cualquier otra cosa → null
export function parsearMonto(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? redondear2(v) : null;
  if (v === null || v === undefined) return null;
  const limpio = String(v).replace(/B\/\.?/gi, '').replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(limpio)) return null;
  const n = Number(limpio);
  return n > 0 ? redondear2(n) : null;
}

// Fecha de Panamá (UTC-5, sin horario de verano) como { y, m, d }
function partesPanama(ahora) {
  const p = new Date(ahora.getTime() - 5 * 3600 * 1000);
  return { y: p.getUTCFullYear(), m: p.getUTCMonth() + 1, d: p.getUTCDate() };
}

function iso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function esFechaReal(y, m, d) {
  const f = new Date(Date.UTC(y, m - 1, d));
  return f.getUTCFullYear() === y && f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
}

export function fechaIsoPanama(ahora = new Date()) {
  const { y, m, d } = partesPanama(ahora);
  return iso(y, m, d);
}

export function fechaLegible(isoFecha) {
  const m = String(isoFecha || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(isoFecha || '');
}

/**
 * Interpreta la fecha que dijo el usuario. Hoy por defecto.
 * Acepta: vacío/"hoy", "ayer", "antier/anteayer", "DD/MM/YYYY", "DD-MM-YYYY", "DD/MM" (año actual).
 * @returns {{ ok: true, fecha: string } | { ok: false, motivo: 'no_entendida'|'futura'|'inexistente' }}
 */
export function interpretarFechaPago(texto, ahora = new Date()) {
  const hoy = partesPanama(ahora);
  const hoyIso = iso(hoy.y, hoy.m, hoy.d);
  const t = sinTildes(texto);
  if (t === '' || t === 'hoy') return { ok: true, fecha: hoyIso };

  const restarDias = n => {
    const f = new Date(Date.UTC(hoy.y, hoy.m - 1, hoy.d - n));
    return iso(f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate());
  };
  if (t === 'ayer') return { ok: true, fecha: restarDias(1) };
  if (t === 'antier' || t === 'anteayer') return { ok: true, fecha: restarDias(2) };

  const m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{4}))?$/);
  if (!m) return { ok: false, motivo: 'no_entendida' };
  const d = Number(m[1]);
  const mes = Number(m[2]);
  const y = m[3] ? Number(m[3]) : hoy.y;
  if (!esFechaReal(y, mes, d)) return { ok: false, motivo: 'inexistente' };
  const resultado = iso(y, mes, d);
  if (resultado > hoyIso) return { ok: false, motivo: 'futura' };
  return { ok: true, fecha: resultado };
}

// "4", "004", "No. 4", "factura 004" → "004"; sin número → null
export function normalizarNumeroDocumento(v) {
  const m = String(v ?? '').match(/\d+/);
  if (!m) return null;
  return String(Number(m[0])).padStart(3, '0');
}

// Para comparar nombres de clientes: sin tildes, minúsculas, espacios simples
export function claveNombre(v) {
  return sinTildes(v).replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * ¿El cliente que dijo el usuario corresponde al cliente del documento?
 * Igual, o uno contiene al otro palabra por palabra ("Juan" ↔ "Juan Pérez").
 */
export function mismoCliente(dicho, delDocumento) {
  const a = claveNombre(dicho);
  const b = claveNombre(delDocumento);
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = a.split(' ');
  const pb = b.split(' ');
  const [corto, largo] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
  return corto.every(p => largo.includes(p));
}

/**
 * Saldo de cada documento = total − pagos vigentes. Nunca se guarda: se deriva.
 * @param {Array<{id, total}>} documentos
 * @param {Array<{documento_id, monto}>} pagosVigentes  (ya sin anulados)
 * @returns {Map<number, number>}
 */
export function calcularSaldos(documentos, pagosVigentes) {
  const pagado = new Map();
  for (const p of pagosVigentes || []) {
    if (p.documento_id == null) continue;
    pagado.set(p.documento_id, (pagado.get(p.documento_id) || 0) + Number(p.monto));
  }
  const saldos = new Map();
  for (const d of documentos || []) {
    saldos.set(d.id, redondear2(Number(d.total) - (pagado.get(d.id) || 0)));
  }
  return saldos;
}

/**
 * Reparte un pago entre documentos, EN EL ORDEN RECIBIDO (el llamador decide el
 * orden: uno solo elegido por el usuario, o del más antiguo al más nuevo si él lo
 * pidió). Lo que sobra queda como saldo a favor. Nunca aplica más que el saldo.
 * @param {number} monto
 * @param {Array<{id, saldo}>} destinos
 * @returns {{ aplicaciones: Array<{documento_id, monto, saldoAntes, saldoDespues}>, saldoAFavor: number }}
 */
export function repartirPago(monto, destinos) {
  let resto = redondear2(monto);
  const aplicaciones = [];
  for (const d of destinos) {
    if (resto <= EPS) break;
    if (d.saldo <= EPS) continue;
    const aplicado = redondear2(Math.min(resto, d.saldo));
    aplicaciones.push({
      documento_id: d.id,
      monto: aplicado,
      saldoAntes: redondear2(d.saldo),
      saldoDespues: redondear2(d.saldo - aplicado),
    });
    resto = redondear2(resto - aplicado);
  }
  return { aplicaciones, saldoAFavor: resto > EPS ? resto : 0 };
}

const nombreDoc = d => `Factura proforma ${d.numero}`;

/** Texto de la vista previa: el efecto completo, antes de guardar nada. */
export function textoVistaPrevia({ cliente, monto, fecha, hoy, aplicaciones, saldoAFavor, documentos, avisos = [] }) {
  const porId = new Map(documentos.map(d => [d.id, d]));
  const lineas = [`Voy a registrar un pago de ${formatoMonto(monto)}${cliente ? ` de ${cliente}` : ''}, con fecha ${fechaLegible(fecha)}${fecha === hoy ? ' (hoy)' : ''}:`, ''];
  for (const a of aplicaciones) {
    const d = porId.get(a.documento_id);
    const cli = d.cliente ? ` (${d.cliente})` : '';
    lineas.push(`• ${nombreDoc(d)}${cli}: ${formatoMonto(a.monto)} — debía ${formatoMonto(a.saldoAntes)}, quedará ${formatoMonto(a.saldoDespues)}${a.saldoDespues <= EPS ? ' (pagada)' : ''}`);
  }
  if (saldoAFavor > EPS) {
    lineas.push(`• ${formatoMonto(saldoAFavor)} quedan como saldo a favor${cliente ? ` de ${cliente}` : ''}, sin aplicar a ninguna factura`);
  }
  for (const av of avisos) lineas.push('', `⚠️ ${av}`);
  lineas.push('', '¿Lo registro? Responde "sí" para guardarlo o "no" para cancelar.');
  return lineas.join('\n');
}

/** Lista de facturas pendientes cuando hay varias posibles. */
export function textoElegirDocumento({ cliente, monto, candidatos, concepto = 'el pago' }) {
  const lineas = [`${cliente ? cliente : 'Ese cliente'} tiene ${candidatos.length} facturas pendientes. Para ${concepto} de ${formatoMonto(monto)}, ¿a cuál lo aplico?`, ''];
  for (const c of candidatos) {
    lineas.push(`• ${nombreDoc(c)}${c.cliente ? ` (${c.cliente})` : ''} — ${fechaLegible(c.fecha)} — saldo ${formatoMonto(c.saldo)}`);
  }
  lineas.push('', 'Dime el número (ej. "004"), o responde "al más antiguo" para aplicarlo de la más vieja a la más nueva. Responde "no" para cancelar.');
  return lineas.join('\n');
}

/** Orden "del más antiguo al más nuevo": fecha, y a igual fecha el id (orden de creación). */
export function ordenarMasAntiguoPrimero(candidatos) {
  return [...candidatos].sort((a, b) => {
    const fa = a.fecha || '9999-99-99';
    const fb = b.fecha || '9999-99-99';
    return fa < fb ? -1 : fa > fb ? 1 : a.id - b.id;
  });
}

/**
 * Respuesta del usuario a la vista previa. Estricta a propósito (es dinero):
 * solo vale "sí" / "no" a secas; "sí, pero eran 80" NO confirma.
 * @returns {'confirmar'|'cancelar'|'otra'}
 */
export function clasificarRespuestaConfirmacion(texto) {
  const t = sinTildes(texto).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (['si', 'si confirmo', 'confirmo', 'confirmar', 'dale', 'ok', 'correcto', 'si correcto'].includes(t)) return 'confirmar';
  if (['no', 'cancela', 'cancelar', 'descarta', 'descartar', 'no gracias'].includes(t)) return 'cancelar';
  return 'otra';
}

/**
 * Respuesta del usuario a "¿a cuál lo aplico?".
 * @returns {{ accion: 'cancelar' } | { accion: 'mas_antiguo' } | { accion: 'numero', numero: string } | { accion: 'otra' }}
 */
export function clasificarRespuestaElegir(texto) {
  const t = sinTildes(texto).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (['no', 'cancela', 'cancelar', 'descarta', 'descartar'].includes(t)) return { accion: 'cancelar' };
  if (/^(al |a la |el |la )?(mas antigu[oa]|mas vieja?|mas viej[oa]|primera|primero)$/.test(t)) return { accion: 'mas_antiguo' };
  const m = t.match(/^(?:factura |proforma |factura proforma |la |el |no |numero |num )*0*(\d{1,6})$/);
  if (m) return { accion: 'numero', numero: String(Number(m[1])).padStart(3, '0') };
  return { accion: 'otra' };
}

// ══════════════════════════════════════════════════════════════════
// AJUSTES (fase 1b-3): anular un pago, anular un documento, aplicar un saldo a favor.
// Todo SOLO AGREGA o ANULA (anulado = 1): nunca se borra ni se cambia un monto. Cada plan
// conserva el dinero: lo que se anula = lo que se vuelve a crear (con la fecha ORIGINAL del
// pago, para que "cuánto cobré este mes" no se mueva).
// ══════════════════════════════════════════════════════════════════

const fechaCorta = f => fechaLegible(f);

/** Filtra pagos vigentes por lo que dijo el usuario. Cada filtro solo se aplica si vino. */
export function filtrarPagos(pagos, { cliente, monto, numero, fecha } = {}) {
  return (pagos || []).filter(p => {
    if (cliente && !mismoCliente(cliente, p.referencia)) return false;
    if (monto != null && Math.abs(Number(p.monto) - monto) > EPS) return false;
    if (numero && p.doc_numero !== numero) return false;
    if (fecha && p.fecha !== fecha) return false;
    return true;
  });
}

function descripcionPago(p) {
  const destino = p.documento_id != null
    ? `aplicado a la Factura proforma ${p.doc_numero}`
    : p.tipo === 'saldo_a_favor' ? 'saldo a favor sin aplicar' : String(p.tipo).replace(/_/g, ' ');
  return `${formatoMonto(p.monto)}${p.referencia ? ` de ${p.referencia}` : ''} — ${fechaCorta(p.fecha)} — ${destino}`;
}

/** Lista numerada (más reciente primero) cuando hay varios pagos posibles. */
export function textoElegirPago({ candidatos, accion = 'anular' }) {
  const lineas = [`Encontré ${candidatos.length} pagos que coinciden. ¿Cuál quieres ${accion}?`, ''];
  candidatos.forEach((p, i) => lineas.push(`${i + 1}. ${descripcionPago(p)}`));
  lineas.push('', 'Dime el número de la lista (ej. "1"), o "el último" para el más reciente. Responde "no" para cancelar.');
  return lineas.join('\n');
}

/**
 * Respuesta a una lista numerada (1..n, la 1 es la más reciente).
 * @returns {{ accion: 'cancelar' } | { accion: 'indice', indice: number } | { accion: 'otra' }}
 */
export function clasificarRespuestaElegirIndice(texto, n) {
  const t = sinTildes(texto).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (['no', 'cancela', 'cancelar', 'descarta', 'descartar'].includes(t)) return { accion: 'cancelar' };
  if (/^(el |la )?(ultimo|ultima|mas reciente|reciente)$/.test(t)) return { accion: 'indice', indice: 1 };
  const m = t.match(/^(?:el |la |numero |num |no |n )*(\d{1,3})$/);
  if (m) {
    const i = Number(m[1]);
    if (i >= 1 && i <= n) return { accion: 'indice', indice: i };
  }
  return { accion: 'otra' };
}

/** Anular UN pago: el pago deja de contar; si estaba aplicado a una factura, esta vuelve a deber ese monto. */
export function planAnularPago(pago, saldoDocumentoAhora = null) {
  const plan = { anular: [pago.id], nuevos: [], documentoAnular: null };
  if (pago.documento_id != null && saldoDocumentoAhora != null) {
    plan.saldoAntes = redondear2(saldoDocumentoAhora);
    plan.saldoDespues = redondear2(saldoDocumentoAhora + Number(pago.monto));
  }
  return plan;
}

export function textoPrevioAnularPago(pago, plan) {
  const lineas = ['Voy a ANULAR este pago:', '', `• ${descripcionPago(pago)}`, ''];
  if (plan.saldoAntes != null) {
    lineas.push(`La Factura proforma ${pago.doc_numero} pasa de deber ${formatoMonto(plan.saldoAntes)} a deber ${formatoMonto(plan.saldoDespues)}.`);
  } else {
    lineas.push('Ese dinero deja de contar como saldo a favor.');
  }
  lineas.push('El pago NO se borra: queda anulado y deja de contar en lo cobrado.', '', '¿Lo anulo? Responde "sí" para anularlo o "no" para cancelar.');
  return lineas.join('\n');
}

/**
 * Anular un DOCUMENTO: el documento queda 'anulada'. Si tenía pagos vigentes, el dinero SÍ entró:
 * cada pago se anula y se crea un saldo a favor del cliente con la misma fecha y monto.
 */
export function planAnularDocumento(doc, pagosDelDocumento) {
  const pagos = pagosDelDocumento || [];
  return {
    anular: pagos.map(p => p.id),
    nuevos: pagos.map(p => ({
      fecha: p.fecha, monto: redondear2(Number(p.monto)), tipo: 'saldo_a_favor', documento_id: null,
      referencia: p.referencia || doc.cliente || null,
      concepto: `Saldo a favor por anulación de ${doc.tipo === 'cotizacion' ? 'Cotización' : 'Factura proforma'} ${doc.numero}`,
    })),
    documentoAnular: doc.id,
    totalPagos: redondear2(pagos.reduce((a, p) => a + Number(p.monto), 0)),
  };
}

export function textoPrevioAnularDocumento(doc, plan) {
  const nombre = `${doc.tipo === 'cotizacion' ? 'Cotización' : 'Factura proforma'} ${doc.numero}`;
  const lineas = [`Voy a ANULAR la ${nombre}${doc.cliente ? ` (${doc.cliente})` : ''}, por ${formatoMonto(doc.total)}.`, ''];
  if (plan.totalPagos > EPS) {
    lineas.push(`Tiene pagos por ${formatoMonto(plan.totalPagos)}. Ese dinero SÍ entró, así que pasa a saldo a favor${doc.cliente ? ` de ${doc.cliente}` : ''} (con las mismas fechas y montos). Después puedes aplicarlo a otra factura.`);
  }
  if (doc.tipo !== 'cotizacion') lineas.push('La factura deja de contar como por cobrar.');
  lineas.push('El documento NO se borra: se conserva marcado como anulado.', '', '¿La anulo? Responde "sí" para anularla o "no" para cancelar.');
  return lineas.join('\n');
}

/**
 * APLICAR saldo a favor a facturas. Se consume del más antiguo al más nuevo; cada pago aplicado
 * conserva la fecha del dinero original; si un saldo se usa a medias, el resto queda como saldo a favor.
 * @param {Array<{id, fecha, monto, referencia}>} saldoRows  vigentes, en orden de consumo
 * @param {Array<{documento_id, monto}>} aplicaciones
 */
export function planAplicarSaldo(saldoRows, aplicaciones) {
  const cola = (saldoRows || []).map(r => ({ ...r, resta: redondear2(Number(r.monto)), tocado: false }));
  const nuevos = [];
  for (const a of aplicaciones) {
    let falta = redondear2(a.monto);
    for (const r of cola) {
      if (falta <= EPS) break;
      if (r.resta <= EPS) continue;
      const toma = redondear2(Math.min(falta, r.resta));
      nuevos.push({ fecha: r.fecha, monto: toma, tipo: 'cobro_documento', documento_id: a.documento_id, referencia: r.referencia || null, concepto: 'Aplicado desde saldo a favor' });
      r.resta = redondear2(r.resta - toma);
      r.tocado = true;
      falta = redondear2(falta - toma);
    }
  }
  const anular = cola.filter(r => r.tocado).map(r => r.id);
  for (const r of cola) {
    if (r.tocado && r.resta > EPS) {
      nuevos.push({ fecha: r.fecha, monto: r.resta, tipo: 'saldo_a_favor', documento_id: null, referencia: r.referencia || null, concepto: 'Saldo a favor restante' });
    }
  }
  return { anular, nuevos, documentoAnular: null };
}

export function textoPrevioAplicarSaldo({ cliente, aplicaciones, documentos, disponible, restante }) {
  const porId = new Map(documentos.map(d => [d.id, d]));
  const lineas = [`Voy a aplicar saldo a favor${cliente ? ` de ${cliente}` : ''} (tiene ${formatoMonto(disponible)} disponibles):`, ''];
  for (const a of aplicaciones) {
    const d = porId.get(a.documento_id);
    lineas.push(`• Factura proforma ${d.numero}${d.cliente ? ` (${d.cliente})` : ''}: ${formatoMonto(a.monto)} — debía ${formatoMonto(a.saldoAntes)}, quedará ${formatoMonto(a.saldoDespues)}${a.saldoDespues <= EPS ? ' (pagada)' : ''}`);
  }
  lineas.push('', restante > EPS ? `Quedarán ${formatoMonto(restante)} de saldo a favor.` : 'No quedará saldo a favor.');
  lineas.push('Los pagos conservan la fecha en que entró el dinero.', '', '¿Lo aplico? Responde "sí" para aplicarlo o "no" para cancelar.');
  return lineas.join('\n');
}

// ── Red de seguridad sobre la llamada de Groq (fase 1b-3b) ──────────────────────────────
// Groq extrae; el código decide. Dos errores reales vistos en producción:
//  (1) "Ana pagó 200 de la factura 004" se envió como anular_pago porque el último mensaje del
//      bot del historial era "¿Cuál pago quieres anular?".
//  (2) "Anula la factura proforma 001 (Juan Pérez)" llegó sin numero_documento.
// Aquí se corrige SOLO con el texto original del usuario, sin gastar tokens.

// Verbos de pago CON tilde o en plural. "pago"/"abono" sin tilde se dejan a Groq: son ambiguos
// con el sustantivo ("anula el pago de Ana"). Se evita \b porque en JS no ve la ó como letra.
const RE_VERBO_PAGO = /(^|[^a-záéíóúñ])(pagó|abonó|canceló|pagaron|abonaron|cancelaron)(?![a-záéíóúñ])/i;
// Cualquier señal de querer deshacer algo: si aparece, NO se toca la decisión de Groq.
const RE_INTENCION_ANULAR = /\b(anul\w*|deshac\w*|deshaz\w*|equivoq\w*|equivoc\w*|error|revert\w*|elimin\w*|borr\w*|quita\w*|corrig\w*)\b/;
// Señales de que el usuario SÍ quiere agregar a alguien nuevo (no abonar): ahí no se reencamina.
const RE_INTENCION_AGREGAR = /\b(agreg\w*|anad\w*|nuev[oa]s?|cre[ao]\w*|registr\w*|apunt\w*|inscrib\w*|prest\w*)\b/;
const RE_NUMERO_DOC = /\b(?:factura(?:\s+proforma)?|proforma|cotizacion|nota\s+de\s+cobro)\s*(?:n(?:o|um(?:ero)?)?\.?\s*)?#?\s*(\d{1,6})\b/;

/**
 * @param {string} texto  Lo que escribió el usuario (o la transcripción).
 * @param {string} nombre Herramienta que eligió Groq.
 * @param {object} args   Argumentos que mandó Groq.
 * @returns {{ nombre: string, args: object, corregida: string|null }}
 */
export function corregirLlamadaPago(texto, nombre, args) {
  const a = { ...(args || {}) };
  const original = String(texto ?? '');
  const plano = sinTildes(original);

  // (0) "Zzz abonó 10" que Groq mandó como agregar_fila: un verbo de pago (con tilde o plural), sin intención
  // de agregar ni de anular y con un valor de abono legible, es un ABONO a alguien que ya debería existir.
  // Pasa por actualizar_fila → resolverAbonoPorPersona, que no registra nada si la persona no existe.
  if (nombre === 'agregar_fila' && RE_VERBO_PAGO.test(original) && !RE_INTENCION_ANULAR.test(plano) && !RE_INTENCION_AGREGAR.test(plano)) {
    const valores = a.valores && typeof a.valores === 'object' ? a.valores : {};
    const claveAbono = Object.keys(valores).find(k => esCampoDeAbono(k));
    if (String(a.nombre ?? '').trim() && claveAbono && parsearMonto(valores[claveAbono]) !== null) {
      return {
        nombre: 'actualizar_fila',
        args: { nombre_cuadro: a.nombre_cuadro ?? null, nombre: a.nombre, campo: claveAbono, valor: String(valores[claveAbono]) },
        corregida: 'agregar_fila→actualizar_fila (abono)',
      };
    }
  }

  if (nombre !== 'ajustar_pago') return { nombre, args: a, corregida: null };
  const accion = String(a.accion ?? '').trim();

  // (1) "pagó/abonó…" sin intención de anular, con monto legible → es un pago nuevo.
  if (accion === 'anular_pago' && RE_VERBO_PAGO.test(original) && !RE_INTENCION_ANULAR.test(plano) && parsearMonto(a.monto) !== null) {
    return {
      nombre: 'registrar_pago',
      args: { cliente: a.cliente ?? null, monto: a.monto, numero_documento: a.numero_documento ?? null, fecha: a.fecha ?? null },
      corregida: 'anular_pago→registrar_pago',
    };
  }

  // (2) anular un documento sin número: se saca del texto del usuario.
  if (accion === 'anular_documento' && !normalizarNumeroDocumento(a.numero_documento)) {
    const m = plano.match(RE_NUMERO_DOC);
    if (m) {
      a.numero_documento = m[1];
      if (!String(a.tipo_documento ?? '').trim()) a.tipo_documento = /cotizacion/.test(m[0]) ? 'cotizacion' : 'factura';
      return { nombre, args: a, corregida: 'numero_documento_desde_texto' };
    }
  }
  return { nombre, args: a, corregida: null };
}

/** true solo si el mensaje es exactamente un "sí" o un "no" (mismo clasificador estricto de las confirmaciones). */
export function esSiNoPuro(texto) {
  const c = clasificarRespuestaConfirmacion(texto);
  return c === 'confirmar' || c === 'cancelar';
}

// ── Abonos de préstamos en el cuadro (fase 1b-4a) ───────────────────────────────────────
// Lista determinista de columnas de pago: la clave empieza por "abono" ("abono", "abono_a_capital").
// El saldo del préstamo lo sigue calculando el cuadro; `pagos` solo registra el hecho del abono.
const RE_COLUMNA_ABONO = /^abono(_|$)/;

/**
 * ¿El campo que se actualiza es una columna de abono? Devuelve la CLAVE real de la columna o null.
 * Si Groq dice "abono" y el cuadro tiene una sola columna que empieza por abono, se usa esa.
 * @param {string} campo   Campo ya normalizado (ej. "abono").
 * @param {string[]} claves Claves normalizadas de las columnas del cuadro.
 */
export function columnaDePago(campo, claves) {
  const c = String(campo ?? '');
  const lista = Array.isArray(claves) ? claves : [];
  if (!RE_COLUMNA_ABONO.test(c)) return null;
  if (lista.includes(c)) return c;
  const candidatas = lista.filter(k => RE_COLUMNA_ABONO.test(k));
  return candidatas.length === 1 ? candidatas[0] : null;
}

/**
 * El abono se SUMA al acumulado de la fila (antes se reemplazaba y se perdía el anterior).
 * @returns {{ ok: false } | { ok: true, monto: number, previo: number, nuevo: number }}
 */
export function acumularAbono(actual, valor) {
  const monto = parsearMonto(valor);
  if (monto === null) return { ok: false };
  const n = Number(actual);
  const previo = Number.isFinite(n) ? redondear2(n) : 0;
  return { ok: true, monto, previo, nuevo: redondear2(previo + monto) };
}

// Un abono que se SUMA no sirve para corregir otro. Si el texto pide corregir/cambiar/dejar el abono
// en otro valor, se rechaza con aviso (hasta que exista "anular abono", fase 1b-4b) en vez de sumar a ciegas.
const RE_CORRECCION_ABONO = /\b(corrig\w*|cambi\w*|modific\w*|ajust\w*|pon(?:e|er|ga|gas|lo)?|deja(?:r|lo)?|equivoq\w*|equivoc\w*|en realidad|mejor dicho|el abono(?:\s+\w+){0,3}\s+(?:es|era|queda|quedo|seria))\b/;
export function esCorreccionDeAbono(texto) {
  return RE_CORRECCION_ABONO.test(sinTildes(String(texto ?? '')));
}

// ── "¿Quién me debe?" (fase 1c) ─────────────────────────────────────────────────────────
// Es una consulta de información: se detecta y se responde en código (0 tokens de Groq).
// "lista de cobros" / "cóbrale a Juan" NO entran aquí: siguen en generar_cobro (redacta mensajes).

const RELLENO_INICIO = /^(?:(?:hola|oye|buenas|buenos dias|buenas tardes|buenas noches|dime|a ver|por favor|porfa)\s+)+/;
const RELLENO_FINAL = /\s+(?:hoy|ahora|por favor|porfa|gracias)$/;
// Frases ANCLADAS (el mensaje completo, sin tildes ni mayúsculas): una mención suelta no dispara el reporte.
const FRASES_DEUDAS = [
  /^quien(?:es)? me debe(?:n)?(?: (?:plata|dinero))?$/,
  /^cuanto(?: dinero| plata)? me debe(?:n)?$/,
  /^cuanta (?:plata|dinero) me deben$/,
  /^que me deben$/,
  /^cuentas por cobrar$/,
  /^(?:mis )?deudores$/,
  /^(?:mis )?cobros pendientes$/,
  /^(?:ver |dame |muestrame )?(?:mis )?deudas por cobrar$/,
];
// Palabras que NO son un nombre: "cuánto me debe este mes" no es una consulta por cliente.
const NO_ES_NOMBRE = new Set(['este', 'esta', 'ese', 'esa', 'el', 'la', 'los', 'las', 'un', 'una', 'hoy', 'ahora', 'mes', 'semana',
  'total', 'todo', 'todos', 'todas', 'alguien', 'nadie', 'cada', 'cliente', 'clientes', 'gente', 'persona', 'personas',
  'mas', 'menos', 'cuanto', 'quien', 'quienes', 'por', 'favor', 'gracias', 'porfa']);

/**
 * @returns {null | { tipo: 'todas' } | { tipo: 'cliente', cliente: string }}
 */
export function detectarConsultaDeudas(texto) {
  const plano = sinTildes(texto).replace(/[¿?¡!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!plano || plano.length > 70) return null;
  let t = plano;
  for (let i = 0; i < 3; i++) t = t.replace(RELLENO_INICIO, '').replace(RELLENO_FINAL, '').trim();
  if (FRASES_DEUDAS.some(re => re.test(t))) return { tipo: 'todas' };

  // "¿Cuánto me debe Ana?": se extrae el nombre del texto ORIGINAL para conservar mayúsculas y tildes.
  const original = String(texto ?? '').replace(/[¿?¡!]/g, ' ').replace(/[.,;:]+\s*$/, '').replace(/\s+/g, ' ').trim();
  const m = original.match(/^(?:(?:hola|oye|buenas|dime|a ver|por favor|porfa)[ ,]+)*cu[aá]nto(?:\s+(?:dinero|plata))?\s+me\s+debe\s+(.+)$/i);
  if (!m) return null;
  const tokens = m[1].trim().split(' ').filter(Boolean);
  // Rellenos al final ("… Ana hoy", "… Ana por favor") no son parte del nombre.
  const RELLENO_NOMBRE = new Set(['hoy', 'ahora', 'gracias', 'porfa', 'favor']);
  while (tokens.length > 0 && RELLENO_NOMBRE.has(sinTildes(tokens[tokens.length - 1]))) {
    tokens.pop();
    if (tokens.length > 0 && sinTildes(tokens[tokens.length - 1]) === 'por') tokens.pop();
  }
  if (tokens.length < 1 || tokens.length > 3) return null;
  if (!tokens.every(x => /^[\p{L}'’-]+$/u.test(x))) return null;
  if (tokens.some(x => NO_ES_NOMBRE.has(sinTildes(x)))) return null;
  return { tipo: 'cliente', cliente: tokens.join(' ') };
}

/**
 * Personas con saldo pendiente en los cuadros de préstamos. Un cuadro cuenta si tiene una columna de abono
 * (la misma regla de 1b-4a) Y una columna `saldo`; los demás (cotizaciones, facturas, sin `columnas`) se saltan.
 * @param {Array<{nombre_cuadro, estructura, filas}>} cuadros  filas de la tabla cuadros (JSON como texto u objeto)
 * @param {(texto: string) => string} normalizar  normalizarClave de whatsapp.js (se inyecta, esta lib no la tiene)
 */
export function extraerPrestamosDeCuadros(cuadros, normalizar) {
  const items = [];
  const incluidos = [];
  let sinSaldoLegible = 0;
  for (const c of cuadros || []) {
    const filas = filasDeCuadroDePrestamo(c, normalizar);
    if (!filas) continue;
    incluidos.push(c.nombre_cuadro);
    for (const f of filas) {
      if (!f || typeof f !== 'object') continue;
      if (typeof f.saldo !== 'number' || !Number.isFinite(f.saldo)) { if (f.nombre) sinSaldoLegible++; continue; }
      if (f.saldo > EPS) items.push({ persona: String(f.nombre ?? '(sin nombre)'), saldo: redondear2(f.saldo), cuadro: c.nombre_cuadro });
    }
  }
  items.sort((a, b) => b.saldo - a.saldo || a.persona.localeCompare(b.persona, 'es'));
  return { items, cuadros: incluidos, sinSaldoLegible };
}

/** Saldo a favor vigente por cliente (pagos tipo saldo_a_favor no anulados), uniendo variantes del nombre. */
export function agruparSaldosAFavor(pagosVigentes) {
  const grupos = [];
  for (const p of pagosVigentes || []) {
    if (p.tipo !== 'saldo_a_favor') continue;
    const nombre = String(p.referencia ?? '').trim() || '(sin nombre)';
    const g = grupos.find(x => (nombre === '(sin nombre)' || x.cliente === '(sin nombre)') ? x.cliente === nombre : mismoCliente(x.cliente, nombre));
    if (g) {
      g.monto += Number(p.monto);
      if (nombre.length > g.cliente.length) g.cliente = nombre;
    } else {
      grupos.push({ cliente: nombre, monto: Number(p.monto) });
    }
  }
  return grupos.map(g => ({ cliente: g.cliente, monto: redondear2(g.monto) }))
    .filter(g => g.monto > EPS)
    .sort((a, b) => b.monto - a.monto);
}

/**
 * Arma el reporte "¿Quién me debe?" en UN solo mensaje. Los totales cuentan todo; si el texto pasa de
 * `maxChars` se recortan líneas (nunca totales). Si falta un módulo, lo dice en vez de inventar.
 * @param {{ prestamos: {items, cuadros, sinSaldoLegible}, facturas: {items, totalDocs}, saldosAFavor: Array }} datos
 * @param {{ cliente?: string|null, maxChars?: number }} opciones
 */
export function armarReporteDeudas(datos, opciones = {}) {
  const filtro = String(opciones.cliente ?? '').trim() || null;
  const maxChars = opciones.maxChars || 3800;
  const pre = datos?.prestamos || { items: [], cuadros: [], sinSaldoLegible: 0 };
  const fac = datos?.facturas || { items: [], totalDocs: 0 };
  const coincide = n => !filtro || mismoCliente(filtro, n);

  const prestamos = (pre.items || []).filter(i => coincide(i.persona));
  const facturas = (fac.items || []).filter(f => f.saldo > EPS && coincide(f.cliente))
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : String(a.numero).localeCompare(String(b.numero))));
  const aFavor = (datos?.saldosAFavor || []).filter(s => coincide(s.cliente));

  const hayCuadros = (pre.cuadros || []).length > 0;
  const hayProformas = fac.totalDocs > 0;
  if (!hayCuadros && !hayProformas) {
    return 'Todavía no tengo préstamos ni facturas proforma registrados, así que no puedo decirte quién te debe.';
  }

  const subPre = redondear2(prestamos.reduce((a, i) => a + i.saldo, 0));
  const subFac = redondear2(facturas.reduce((a, f) => a + f.saldo, 0));
  const total = redondear2(subPre + subFac);
  const hayDeuda = prestamos.length + facturas.length > 0;
  const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

  const lPre = prestamos.map(i => `• ${i.persona} — ${formatoMonto(i.saldo)} (${i.cuadro})`);
  const lFac = facturas.map(f => `• Factura proforma ${f.numero}${f.cliente ? ` (${f.cliente})` : ''} — ${formatoMonto(f.saldo)} — ${fechaLegible(f.fecha)}`);
  const lFavor = aFavor.slice(0, 8).map(s => {
    const tieneDeuda = facturas.some(f => mismoCliente(s.cliente, f.cliente));
    return `• ${s.cliente}: ${formatoMonto(s.monto)}${tieneDeuda ? ' — puedes aplicarlo a su factura' : ''}`;
  });
  if (aFavor.length > 8) lFavor.push(`• … y ${aFavor.length - 8} más`);

  const render = (nP, nF) => {
    const out = [filtro ? `💰 Lo que te debe ${filtro}` : '💰 Esto es lo que te deben'];
    if (!hayDeuda) {
      out.push('', filtro
        ? `No encontré deudas pendientes de ${filtro}. Si el nombre está escrito distinto en tus cuadros, dímelo como aparece.`
        : 'Nadie te debe nada por ahora. 🎉');
    } else {
      if (prestamos.length > 0) {
        out.push('', 'CUADROS DE COBRO (préstamos)', ...lPre.slice(0, nP));
        if (nP < lPre.length) out.push(`• … y ${lPre.length - nP} más`);
        out.push(`Subtotal: ${formatoMonto(subPre)} (${plural(prestamos.length, 'persona', 'personas')})`);
      } else if (!filtro) {
        out.push('', 'CUADROS DE COBRO (préstamos)', hayCuadros ? 'Ninguno con saldo pendiente.' : 'No tienes cuadros de préstamos registrados.');
      }
      if (facturas.length > 0) {
        out.push('', 'FACTURAS POR COBRAR', ...lFac.slice(0, nF));
        if (nF < lFac.length) out.push(`• … y ${lFac.length - nF} más`);
        out.push(`Subtotal: ${formatoMonto(subFac)} (${plural(facturas.length, 'factura', 'facturas')})`);
      } else if (!filtro) {
        out.push('', 'FACTURAS POR COBRAR', hayProformas ? 'Ninguna con saldo pendiente.' : 'No tienes facturas proforma registradas.');
      }
      out.push('', `TOTAL${filtro ? '' : ' QUE TE DEBEN'}: ${formatoMonto(total)}`);
    }
    if (lFavor.length > 0) {
      out.push('', 'SALDO A FAVOR DE CLIENTES (sin aplicar; no se descuenta del total)', ...lFavor);
    }
    if (!filtro && pre.sinSaldoLegible > 0) {
      out.push('', `Ojo: ${plural(pre.sinSaldoLegible, 'fila', 'filas')} de préstamos sin saldo legible no se contaron.`);
    }
    if (!filtro && hayCuadros) out.push('', `Cuadros incluidos: ${pre.cuadros.join(', ')}.`);
    // Instrucción (no pregunta): un "sí" después no tendría a qué responder.
    if (prestamos.length > 0) {
      out.push(filtro
        ? `Para preparar el mensaje de cobro, escribe: cóbrale a ${filtro}.`
        : 'Para preparar los mensajes de cobro, escribe: dame la lista de cobros.');
    }
    return out.join('\n');
  };

  let nP = lPre.length;
  let nF = lFac.length;
  let texto = render(nP, nF);
  while (texto.length > maxChars && (nP > 0 || nF > 0)) {
    if (nP >= nF && nP > 0) nP--; else nF--;
    texto = render(nP, nF);
  }
  return texto.length > maxChars ? `${texto.slice(0, maxChars - 1)}…` : texto;
}

// ── Regla única de "cuadro de préstamo" (reporte "¿quién me debe?" y cobro asistido) ───────
/**
 * Si el cuadro es de préstamo (columna de abono + columna `saldo`) devuelve sus filas; si no, null.
 * Los que no tienen `columnas` (ej. PAGO DE QUINCENA), con JSON roto o sin estructura se saltan sin fallar.
 */
function filasDeCuadroDePrestamo(c, normalizar) {
  let est, filas;
  try {
    est = typeof c?.estructura === 'string' ? JSON.parse(c.estructura) : c?.estructura;
    filas = typeof c?.filas === 'string' ? JSON.parse(c.filas) : c?.filas;
  } catch { return null; }
  const columnas = est && Array.isArray(est.columnas) ? est.columnas : null;
  if (!columnas || !Array.isArray(filas)) return null;
  const claves = columnas.map(x => normalizar(x));
  if (!claves.includes('saldo') || !claves.some(k => RE_COLUMNA_ABONO.test(k))) return null;
  return filas;
}

/**
 * Para "dame la lista de cobros" / "cóbrale a Juan" cuando no se indica cuadro: en vez de preguntar entre
 * TODOS los cuadros (cotizaciones y facturas incluidas), se trabaja con los de préstamo. Uno solo → se usa
 * ese. Varios → se unen sus filas en una sola lista (el cobro es por persona, no por cuadro).
 * @returns {null | { cuadro: object, filas: Array, unido: boolean, nombres: string[] }}
 */
export function unirCuadrosDePrestamo(cuadros, normalizar) {
  const validos = [];
  for (const c of cuadros || []) {
    const filas = filasDeCuadroDePrestamo(c, normalizar);
    if (filas) validos.push({ c, filas });
  }
  if (validos.length === 0) return null;
  const nombres = validos.map(v => v.c.nombre_cuadro);
  if (validos.length === 1) return { cuadro: validos[0].c, filas: validos[0].filas, unido: false, nombres };
  return { cuadro: { nombre_cuadro: 'tus cuadros de préstamo', unido: true }, filas: validos.flatMap(v => v.filas), unido: true, nombres };
}

// ── Teléfonos (Panamá) ──────────────────────────────────────────────────────────────────
// Un número de Panamá = 8 dígitos locales, con el prefijo de país 507 delante (11 dígitos en total).
// Antes se guardaba lo que mandara Groq sin revisar: un dígito de más dejaba un enlace de WhatsApp roto.
/**
 * Acepta 8 dígitos (se le antepone 507) u 11 dígitos que empiecen en 507. Se toleran separadores
 * (espacios, guiones, puntos, paréntesis) y un "+" inicial. Cualquier letra o símbolo se RECHAZA:
 * no se "limpia" en silencio, porque un "5O768…" (letra O) acabaría guardando un número equivocado.
 * @returns {{ ok: true, telefono: string } | { ok: false, motivo: 'vacio'|'caracteres'|'formato', digitos?: number }}
 */
export function normalizarTelefonoPanama(texto) {
  const original = String(texto ?? '').trim();
  if (!original) return { ok: false, motivo: 'vacio' };
  if (!/^\+?[\d\s().-]+$/.test(original)) return { ok: false, motivo: 'caracteres' };
  const digitos = original.replace(/\D/g, '');
  if (digitos.length === 8) return { ok: true, telefono: `507${digitos}` };
  if (digitos.length === 11 && digitos.startsWith('507')) return { ok: true, telefono: digitos };
  return { ok: false, motivo: 'formato', digitos: digitos.length };
}

/** Mensaje para el usuario cuando un teléfono no se pudo guardar. `resultado` viene de normalizarTelefonoPanama. */
export function mensajeTelefonoInvalido(texto, resultado) {
  const mostrado = String(texto ?? '').trim().slice(0, 20);
  if (resultado?.motivo === 'caracteres') {
    return `El teléfono "${mostrado}" tiene letras o símbolos que no son de un número. No lo guardé. Mándamelo solo con números, por ejemplo: 6123 4567.`;
  }
  if (resultado?.motivo === 'formato') {
    return `El teléfono "${mostrado}" no parece válido (${resultado.digitos} dígitos). No lo guardé. Mándamelo con 8 dígitos, por ejemplo: 6123 4567, o con el 507 delante.`;
  }
  return 'No recibí un teléfono válido, así que no guardé nada. Mándamelo con 8 dígitos, por ejemplo: 6123 4567.';
}

/**
 * ¿El cuadro contiene, con ese nombre EXACTO (sin distinguir mayúsculas, como buscarFila), a TODAS las
 * personas pedidas? Sirve para decidir si el cuadro que trajo Groq es confiable o hay que buscar en todos
 * los cuadros de préstamo. Sin nombres pedidos devuelve true (no hay nada que contradiga al cuadro).
 */
export function cuadroContieneTodos(cuadro, nombres) {
  const pedidos = (Array.isArray(nombres) ? nombres : []).map(n => String(n ?? '').trim().toLowerCase()).filter(Boolean);
  if (pedidos.length === 0) return true;
  let filas;
  try { filas = typeof cuadro?.filas === 'string' ? JSON.parse(cuadro.filas) : cuadro?.filas; } catch { return false; }
  if (!Array.isArray(filas)) return false;
  const existentes = new Set(filas.map(f => String(f?.nombre ?? '').trim().toLowerCase()));
  return pedidos.every(n => existentes.has(n));
}

// ── Abonos: la PERSONA manda, no el cuadro (fase 1b-4b, entrega 1) ───────────────────────
// Groq a veces hereda el cuadro de un mensaje anterior. Con dinero de por medio el cuadro no puede decidir
// a quién se abona: se busca a la persona en TODOS los cuadros de préstamo y solo una coincidencia EXACTA
// (sin tildes, sin mayúsculas) se registra sola; un nombre parecido pide confirmación.

/** ¿El campo que se actualiza es de abono? ("abono", "Abono a Capital", "abono_a_capital"…) */
export function esCampoDeAbono(campo) {
  const k = sinTildes(campo).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return RE_COLUMNA_ABONO.test(k);
}

/** ¿Es un cuadro de préstamo? (columna de abono + columna `saldo`; la misma regla del reporte y del cobro) */
export function esCuadroDePrestamo(cuadro, normalizar) {
  return filasDeCuadroDePrestamo(cuadro, normalizar) !== null;
}

/** ¿El cuadro tiene alguna columna de abono (aunque no sea de préstamo, ej. un cuadro propio)? */
export function tieneColumnaAbono(cuadro, normalizar) {
  let est;
  try { est = typeof cuadro?.estructura === 'string' ? JSON.parse(cuadro.estructura) : cuadro?.estructura; } catch { return false; }
  const columnas = est && Array.isArray(est.columnas) ? est.columnas : [];
  return columnas.some(x => RE_COLUMNA_ABONO.test(normalizar(x)));
}

/** Clave real de la columna de abono de ESE cuadro a partir de lo que dijo Groq, o null si es ambigua/no hay. */
export function resolverClaveAbono(campo, columnas, normalizar) {
  const claves = (columnas || []).map(x => normalizar(x));
  return columnaDePago(normalizar(campo), claves) || columnaDePago(sinTildes(campo).replace(/\s+/g, '_'), claves);
}

// Si el mensaje del usuario menciona el nombre de UNO de los cuadros donde está la persona, ese es el elegido.
// "Prestamos 2" contiene a "Prestamos": gana el nombre más largo.
function elegirPorNombreDeCuadro(exactos, texto) {
  const t = sinTildes(texto);
  if (!t) return null;
  const nombre = e => sinTildes(e.cuadro.nombre_cuadro);
  const mencionados = exactos.filter(e => nombre(e) && t.includes(nombre(e)));
  const finales = mencionados.filter(a => !mencionados.some(b => b !== a && nombre(b).length > nombre(a).length && nombre(b).includes(nombre(a))));
  return finales.length === 1 ? finales[0] : null;
}

/**
 * Busca a la persona en los cuadros de préstamo. Devuelve el cuadro, SUS filas ya parseadas y la fila (la misma
 * referencia, que es lo que espera abonarEnCuadro).
 * @returns {{tipo:'exacto', cuadro, filas, fila} | {tipo:'exacto_varios', coincidencias} |
 *           {tipo:'parecido', cuadro, filas, fila} | {tipo:'parecidos', candidatos} | {tipo:'ninguno'}}
 * @param {Function} buscarFilaFn  buscarFila de lib/buscarFila.js (se inyecta)
 */
export function buscarPersonaEnPrestamos(nombre, cuadros, normalizar, buscarFilaFn, textoUsuario = '') {
  const buscado = claveNombre(nombre);
  if (!buscado) return { tipo: 'ninguno' };
  const cargados = [];
  for (const c of cuadros || []) {
    const filas = filasDeCuadroDePrestamo(c, normalizar);
    if (filas) cargados.push({ cuadro: c, filas });
  }
  const exactos = [];
  for (const { cuadro, filas } of cargados) {
    for (const fila of filas) if (fila && claveNombre(fila.nombre) === buscado) exactos.push({ cuadro, filas, fila });
  }
  if (exactos.length === 1) return { tipo: 'exacto', ...exactos[0] };
  if (exactos.length > 1) {
    const dicho = elegirPorNombreDeCuadro(exactos, textoUsuario);
    return dicho ? { tipo: 'exacto', ...dicho } : { tipo: 'exacto_varios', coincidencias: exactos };
  }
  const candidatos = [];
  for (const { cuadro, filas } of cargados) {
    const r = buscarFilaFn(nombre, filas);
    if (r.tipo === 'alto' && r.fila) candidatos.push({ cuadro, filas, fila: r.fila });
    else if (r.tipo === 'ambiguo') for (const f of r.candidatos || []) candidatos.push({ cuadro, filas, fila: f });
  }
  if (candidatos.length === 1) return { tipo: 'parecido', ...candidatos[0] };
  if (candidatos.length > 1) return { tipo: 'parecidos', candidatos };
  return { tipo: 'ninguno' };
}

const saldoLegible = f => (Number.isFinite(Number(f?.saldo)) && f?.saldo !== null ? formatoMonto(Number(f.saldo)) : 'sin saldo');

/**
 * ¿El usuario nombró ese cuadro en su mensaje? Si hay otro cuadro con un nombre más largo que lo contiene
 * ("Prestamos 2" contiene a "Prestamos") y ese también está en el texto, se entiende que habló del más largo.
 * @param {string[]} todosLosNombres nombres de todos los cuadros del negocio
 */
export function mencionaCuadro(texto, nombreCuadro, todosLosNombres = []) {
  const t = sinTildes(texto);
  const n = sinTildes(nombreCuadro);
  if (!t || !n || !t.includes(n)) return false;
  return !todosLosNombres.some(otro => {
    const o = sinTildes(otro);
    return o.length > n.length && o.includes(n) && t.includes(o);
  });
}

export function textoRechazoCorreccionAbono(nombre) {
  return `Para corregir un abono hay que anular el anterior y registrar el correcto, y eso todavía no está listo. No cambié nada. Si quieres sumar un abono nuevo, dime por ejemplo: "${nombre || 'Yisel'} abonó 10".`;
}

export function textoVariosExactos(nombre, coincidencias) {
  if (new Set(coincidencias.map(c => c.cuadro.id)).size === 1) {
    return `Hay ${coincidencias.length} filas llamadas "${nombre}" en "${coincidencias[0].cuadro.nombre_cuadro}", así que no sé a cuál abonarle. Cámbiale el nombre a una de ellas para distinguirlas (por ejemplo, agrégale un apellido).`;
  }
  const lineas = coincidencias.map(c => `• ${c.fila.nombre} — ${c.cuadro.nombre_cuadro} (saldo ${saldoLegible(c.fila)})`);
  const ej = coincidencias[0];
  return [`Hay ${coincidencias.length} personas llamadas "${nombre}" en tus cuadros de préstamo:`, ...lineas, '',
    `Dime en qué cuadro, por ejemplo: "${ej.fila.nombre} abonó 10 en ${ej.cuadro.nombre_cuadro}".`].join('\n');
}

export function textoParecidos(nombre, candidatos) {
  const lineas = candidatos.slice(0, 5).map(c => `• ${c.fila.nombre} — ${c.cuadro.nombre_cuadro}`);
  return [`No encontré a "${nombre}" con ese nombre exacto. Se parece a:`, ...lineas, '',
    `Dime el nombre exacto, por ejemplo: "${candidatos[0].fila.nombre} abonó 10".`].join('\n');
}

export function textoNingunoEnPrestamos(nombre) {
  return `No encontré a "${nombre}" en tus cuadros de préstamo. Si es un préstamo nuevo, primero agrégalo al cuadro.`;
}

export function textoConfirmarAbonoParecido({ dicho, nombre, cuadro, monto, abonoAntes, abonoDespues, saldoAntes, saldoDespues }) {
  const lineas = [
    `No encontré a "${dicho}" con ese nombre exacto. ¿Quisiste decir ${nombre} (${cuadro})?`, '',
    `Voy a registrar un abono de ${formatoMonto(monto)} a ${nombre}:`,
    `• Abono acumulado: ${formatoMonto(abonoAntes)} → ${formatoMonto(abonoDespues)}`,
  ];
  if (Number.isFinite(saldoAntes) && Number.isFinite(saldoDespues)) {
    lineas.push(`• Saldo: debía ${formatoMonto(saldoAntes)}, quedará ${formatoMonto(saldoDespues)}`);
  }
  lineas.push('', '¿Lo registro? Responde "sí" para registrarlo o "no" para cancelar.');
  return lineas.join('\n');
}