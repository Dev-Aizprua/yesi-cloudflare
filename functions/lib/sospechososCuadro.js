// functions/lib/sospechososCuadro.js
// Red de seguridad para cuadros leídos de una FOTO. La IA de visión a veces confunde un dígito
// (4/8 → 6) y la fila "Total" de la foto lo delata, pero decirle al usuario "revisa tú" no basta.
// Este módulo, en JavaScript puro (nunca Groq), usa la redundancia del propio cuadro: si 8 de 11
// filas cumplen "interés = monto × 0.12" y "saldo = monto − abono", una fila que no las cumple tiene
// una celda mal leída, y muchas veces el valor correcto se despeja solo.
//
// Solo PROPONE: nada se cambia sin que el usuario responda "corregir".
// Reglas (mismas que detectorFormulas.js): una columna solo se explica con columnas ANTERIORES.

import { validarContraTotales } from './detectorFormulas.js';

const TOL = 0.03;
const esNum = v => typeof v === 'number' && Number.isFinite(v);
const r2 = n => Math.round(n * 100) / 100;
const sinTildes = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function evaluar(regla, fila) {
  if (regla.tipo === 'tasa') return r2(fila[regla.col] * regla.tasa);
  if (regla.tipo === 'producto') return r2(fila[regla.a] * fila[regla.b]);
  return r2(regla.terminos.reduce((s, t) => s + t.signo * fila[t.col], 0));
}
const entradas = regla => (regla.tipo === 'tasa' ? [regla.col] : regla.tipo === 'producto' ? [regla.a, regla.b] : regla.terminos.map(t => t.col));
const cumple = (regla, fila, objetivo) => Math.abs(evaluar(regla, fila) - fila[objetivo]) <= TOL;

function combinaciones(arr, k) {
  const out = [];
  (function rec(ini, acc) {
    if (acc.length === k) { out.push(acc); return; }
    for (let i = ini; i < arr.length; i++) rec(i + 1, [...acc, arr[i]]);
  })(0, []);
  return out;
}

/**
 * Como detectorFormulas.detectarFormulas, pero tolerante: acepta una regla que cumplen la mayoría
 * de las filas (≥ 60 %, y al menos 4), aunque unas pocas filas tengan una celda mal leída.
 * Si dos reglas distintas empatan, no adivina.
 * @returns {Object} { [columna]: regla estructurada }
 */
export function inferirReglasTolerantes(columnas, filas) {
  const n = (filas || []).length;
  if (n < 5) return {};
  const numericas = columnas.filter(c => filas.every(f => esNum(f[c])));
  const minimo = Math.max(4, Math.ceil(n * 0.6));
  const reglas = {};

  numericas.forEach((objetivo, idx) => {
    const previas = numericas.slice(0, idx);
    if (previas.length === 0) return;
    const candidatas = [];
    const cuenta = regla => filas.filter(f => cumple(regla, f, objetivo)).length;

    for (let i = 0; i < previas.length; i++) {
      for (let j = i + 1; j < previas.length; j++) {
        const regla = { tipo: 'producto', a: previas[i], b: previas[j] };
        candidatas.push({ regla, n: cuenta(regla), peso: 0 });
      }
    }
    for (const col of previas) {
      const razones = new Map();
      for (const f of filas) {
        if (f[col] === 0) continue;
        const k = Math.round((f[objetivo] / f[col]) * 10000) / 10000;
        razones.set(k, (razones.get(k) || 0) + 1);
      }
      let mejor = null;
      for (const [tasa, veces] of razones) if (tasa > 0 && tasa !== 1 && (!mejor || veces > mejor.veces)) mejor = { tasa, veces };
      if (mejor) {
        const regla = { tipo: 'tasa', col, tasa: mejor.tasa };
        candidatas.push({ regla, n: cuenta(regla), peso: 1 });
      }
    }
    for (let k = 1; k <= Math.min(3, previas.length); k++) {
      for (const combo of combinaciones(previas, k)) {
        for (let m = 0; m < 2 ** k; m++) {
          const terminos = combo.map((col, i) => ({ col, signo: (m >> i) & 1 ? -1 : 1 }));
          if (terminos.every(t => t.signo < 0)) continue;
          const regla = { tipo: 'suma', terminos };
          candidatas.push({ regla, n: cuenta(regla), peso: 2 + k });
        }
      }
    }

    const buenas = candidatas.filter(c => c.n >= minimo);
    if (buenas.length === 0) return;
    const maxN = Math.max(...buenas.map(c => c.n));
    const tope = buenas.filter(c => c.n === maxN);
    // Empate: gana la más simple solo si es la única de ese peso; si no, ambigua → no se adivina.
    const minPeso = Math.min(...tope.map(c => c.peso));
    const simples = tope.filter(c => c.peso === minPeso);
    if (simples.length === 1) reglas[objetivo] = simples[0].regla;
  });
  return reglas;
}

function resolver(regla, r, fila, T) {
  if (regla.tipo === 'tasa') return regla.col === r ? r2(T / regla.tasa) : null;
  if (regla.tipo === 'producto') {
    const otro = regla.a === r ? regla.b : regla.a;
    return fila[otro] !== 0 ? r2(T / fila[otro]) : null;
  }
  const k = regla.terminos.find(t => t.col === r);
  if (!k) return null;
  const resto = regla.terminos.filter(t => t !== k).reduce((s, t) => s + t.signo * fila[t.col], 0);
  return r2((T - resto) / k.signo);
}

export function aplicarPropuestas(filas, propuestas) {
  const copia = filas.map(f => ({ ...f }));
  for (const p of propuestas || []) if (copia[p.fila]) copia[p.fila][p.columna] = p.a;
  return copia;
}

function describir(regla, bonita) {
  if (regla.tipo === 'tasa') return `${bonita(regla.col)} × ${regla.tasa}`;
  if (regla.tipo === 'producto') return `${bonita(regla.a)} × ${bonita(regla.b)}`;
  return regla.terminos.map((t, i) => (i === 0 ? (t.signo < 0 ? '−' : '') : t.signo < 0 ? ' − ' : ' + ') + bonita(t.col)).join('');
}

/**
 * @param {string[]} columnas  claves internas, en el orden de la foto (la primera es el nombre)
 * @param {string[]} bonitas   nombres tal como se leyeron, mismo orden
 * @param {Object[]} filas
 * @param {Object|null} filaTotales
 * @returns {{ propuestas: Array, cuadra: boolean|null }}
 *   propuestas: [{ fila, nombre, columna, columnaBonita, de, a, tipo: 'lectura'|'derivado', motivo }]
 *   cuadra: ¿aplicando las propuestas los totales de la foto coinciden? (null si no hay propuestas o fila de totales)
 */
export function analizarSospechosos(columnas, bonitas, filas, filaTotales) {
  const vacio = { propuestas: [], cuadra: null };
  if (!filas || filas.length < 5) return vacio;
  const bonita = c => bonitas[columnas.indexOf(c)] ?? c;
  const reglas = inferirReglasTolerantes(columnas, filas);
  const orden = columnas.filter(c => reglas[c]);
  if (orden.length === 0) return vacio;
  const crudas = columnas.filter(c => !reglas[c] && filas.every(f => esNum(f[c])));
  const propuestas = [];

  filas.forEach((fila, i) => {
    const violadas = orden.filter(t => !cumple(reglas[t], fila, t));
    if (violadas.length === 0) return;
    const nombre = fila[columnas[0]];

    // (1) Una celda CRUDA mal leída: un solo valor distinto hace que todas las reglas de la fila cuadren
    // con los valores calculados tal como se leyeron.
    const candidatas = [];
    const vistas = new Set();
    for (const t of violadas) {
      for (const r of entradas(reglas[t])) {
        if (!crudas.includes(r) || vistas.has(r)) continue;
        vistas.add(r);
        const v = resolver(reglas[t], r, fila, fila[t]);
        if (v === null || (v < 0 && filas.every(f => f[r] >= 0))) continue;
        const prueba = { ...fila, [r]: v };
        if (orden.every(tt => cumple(reglas[tt], prueba, tt))) candidatas.push({ columna: r, valor: v });
      }
    }
    if (candidatas.length > 1) return; // ambiguo: no se adivina
    if (candidatas.length === 1) {
      const c = candidatas[0];
      propuestas.push({
        fila: i, nombre, columna: c.columna, columnaBonita: bonita(c.columna), de: fila[c.columna], a: c.valor, tipo: 'lectura',
        motivo: `así cuadran ${violadas.map(bonita).join(' y ')} de esa fila`,
      });
      return;
    }

    // (2) Una celda CALCULADA mal leída: se recalcula con la regla de las demás filas.
    const rec = { ...fila };
    for (const t of orden) {
      const v = evaluar(reglas[t], rec);
      if (Math.abs(v - rec[t]) > TOL) {
        propuestas.push({
          fila: i, nombre, columna: t, columnaBonita: bonita(t), de: rec[t], a: v, tipo: 'derivado',
          motivo: `en las demás filas ${bonita(t)} = ${describir(reglas[t], bonita)}`,
        });
        rec[t] = v;
      }
    }
  });

  if (propuestas.length === 0) return vacio;
  let cuadra = null;
  if (filaTotales) cuadra = validarContraTotales(columnas, aplicarPropuestas(filas, propuestas), filaTotales).coincide;
  return { propuestas, cuadra };
}

export function textoPropuestas(propuestas, cuadra) {
  const lineas = propuestas.map((p, i) => `${i + 1}. ${p.nombre} — ${p.columnaBonita}: leí ${p.de}, creo que es ${p.a} (${p.motivo})`);
  const cierre = cuadra === true ? 'Con estos cambios los totales de la foto SÍ coinciden ✅.'
    : cuadra === false ? 'Ojo: aun con estos cambios los totales de la foto no coinciden del todo.' : '';
  return ['🔎 Creo que estas celdas se leyeron mal (las demás filas siguen una regla y estas no):', ...lineas, ...(cierre ? [cierre] : [])].join('\n');
}

/** Frases exactas (no parciales): "corregir" aplica las propuestas; "crear igual" guarda tal como se leyó. */
export function clasificarAccionPropuesta(texto) {
  const t = sinTildes(texto).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(?:si |ok )?(?:corrige|corregir|corrigelo|corrigelas|corrige todo|corrige los errores|aplica|aplicar|aplicalo|aplicalas|aplica las correcciones|aplica los cambios|haz los cambios)$/.test(t)) return 'corregir';
  if (/^(?:si )?(?:crear|crealo|creala|guardalo|guardala|guardar)(?: igual| asi| tal cual| como esta)$/.test(t)) return 'crear_igual';
  return null;
}