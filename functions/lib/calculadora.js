// functions/lib/calculadora.js
// Calculadora en código (0 tokens, siempre exacta): "¿cuánto es 15 por 12?", "25 por 18", "suma 145, 230 y 75",
// "el 7% de 85", "120 más ITBMS", "107 sin ITBMS". Sin eval: usa su propio analizador.
// Regla de seguridad: solo actúa si TODO el mensaje es un cálculo. Si queda cualquier palabra suelta
// ("vendí 2 panes por 3", "2 galletas por 1 en total") NO lo toca y sigue el flujo normal.

const sinTildes = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const TASA_ITBMS = 7;

const UNI = { cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29 };
const DEC = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const CEN = { cien: 100, ciento: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400, quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900 };
const esNum = w => w in UNI || w in DEC || w in CEN || w === 'mil';

/** Cambia por dígitos las secuencias de números dichos con letras ("veinte", "treinta y cinco", "dos mil"). */
export function numerosEnLetras(t) {
  const pal = t.split(' ');
  const out = [];
  for (let i = 0; i < pal.length;) {
    if (!esNum(pal[i])) { out.push(pal[i]); i++; continue; }
    let total = 0; let cur = 0; let j = i; let ultimoDec = false;
    while (j < pal.length) {
      const w = pal[j];
      if (w === 'mil') { total += (cur || 1) * 1000; cur = 0; ultimoDec = false; j++; }
      else if (w in CEN) { cur += CEN[w]; ultimoDec = false; j++; }
      else if (w in DEC) { cur += DEC[w]; ultimoDec = true; j++; }
      else if (w in UNI) { cur += UNI[w]; ultimoDec = false; j++; }
      else if (w === 'y' && ultimoDec && j + 1 < pal.length && pal[j + 1] in UNI && UNI[pal[j + 1]] >= 1 && UNI[pal[j + 1]] <= 9) { j++; ultimoDec = false; }
      else break;
    }
    out.push(String(total + cur));
    i = j;
  }
  return out.join(' ');
}

// ── Analizador de expresiones: números, + - * / y paréntesis, con precedencia ────────────────────────
function evaluar(expr) {
  const tokens = expr.match(/\d+(?:\.\d+)?|[()+\-*/]/g);
  if (!tokens || tokens.join('') !== expr.replace(/\s+/g, '')) return { error: 'sintaxis' };
  let i = 0;
  const peek = () => tokens[i];
  function primario() {
    const t = tokens[i++];
    if (t === undefined) throw new Error('sintaxis');
    if (t === '(') { const v = suma(); if (tokens[i++] !== ')') throw new Error('sintaxis'); return v; }
    if (t === '-') return -primario();
    if (t === '+') return primario();
    if (/^\d/.test(t)) return parseFloat(t);
    throw new Error('sintaxis');
  }
  function producto() {
    let v = primario();
    while (peek() === '*' || peek() === '/') {
      const op = tokens[i++]; const d = primario();
      if (op === '/') { if (d === 0) throw new Error('cero'); v /= d; } else v *= d;
    }
    return v;
  }
  function suma() {
    let v = producto();
    while (peek() === '+' || peek() === '-') { const op = tokens[i++]; const d = producto(); v = op === '+' ? v + d : v - d; }
    return v;
  }
  try {
    const v = suma();
    if (i !== tokens.length) return { error: 'sintaxis' };
    return { valor: v };
  } catch (e) { return { error: e.message }; }
}

const r2 = n => Math.round((Math.round(n * 1e8) / 1e8) * 100) / 100;
/** 180 → "180"; 5.95 → "5.95"; 0.1+0.2 → "0.3" */
export function formatoNumero(n) {
  const v = r2(n);
  return Number.isInteger(v) ? String(v) : String(v).replace(/(\.\d)0$/, '$1');
}
const dinero = n => r2(n).toFixed(2);
const bonito = e => e.replace(/\*/g, ' × ').replace(/\//g, ' ÷ ').replace(/\+/g, ' + ').replace(/(?<=\d|\))-/g, ' − ').replace(/\s+/g, ' ').trim();

const RE_INICIO = /^(?:(?:dime|dame|me dices|puedes decirme|podrias decirme)\s+)?(?:cuanto\s+(?:es|son|da|dan|seria|serian|sale|salen|me da|nos da|vale|suma|sumaria)|cuanto\s+es\s+que|calcula(?:me|r)?|resultado\s+de|cual\s+es\s+el\s+resultado\s+de|(?:suma(?:me|r)?)|(?:multiplica(?:me|r)?)|(?:divide(?:me)?))\b\s*(?:de\s+|la\s+suma\s+de\s+)?/;
const RE_ITBMS = '(?:itbms|impuesto|i\\.?t\\.?b\\.?m\\.?s\\.?)';

/**
 * @param {string} texto
 * @returns {{ texto: string } | null}  texto = la respuesta lista para enviar; null si no es (claramente) un cálculo
 */
export function responderCalculo(texto) {
  let t = sinTildes(texto).trim();
  if (!t || t.length > 90 || /[a-z]{25,}/.test(t)) return null;
  t = t.replace(/[¿?¡!]/g, ' ').replace(/=\s*$/, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/\$|b\/\.?|\bdolares?\b|\bbalboas?\b|\busd\b/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/\bpor ciento\b|\bpor cien\b|\bporciento\b/g, '%').replace(/\s*%\s*/g, '% ').trim();
  // el punto final de la frase ("cuánto es 15 por 12.")
  t = t.replace(/\.\s*$/, '').trim();
  const lead = t.match(RE_INICIO);
  const verbo = lead ? lead[0] : '';
  const esSuma = /suma(?:me|r)?\b/.test(verbo);
  let r = lead ? t.slice(lead[0].length).trim() : t;
  if (!r) return null;
  r = numerosEnLetras(r);

  // — ITBMS: "120 más itbms", "120 con itbms", "107 sin itbms", "el itbms de 120"
  let m = r.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s+(?:mas|con|\\+)\\s+(?:el\\s+)?${RE_ITBMS}$`));
  if (m) { const b = Number(m[1]); const i = b * TASA_ITBMS / 100; return { texto: `${dinero(b)} + ITBMS (${TASA_ITBMS}%) ${dinero(i)} = ${dinero(b + i)}` }; }
  m = r.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s+(?:sin|menos|quitando|quitale|quitarle)\\s+(?:el\\s+)?${RE_ITBMS}$`));
  if (m) { const tot = Number(m[1]); const b = tot / (1 + TASA_ITBMS / 100); return { texto: `${dinero(tot)} con ITBMS (${TASA_ITBMS}%) = base ${dinero(b)} + ITBMS ${dinero(tot - b)}` }; }
  m = r.match(new RegExp(`^(?:el\\s+)?${RE_ITBMS}\\s+(?:de|del)\\s+(\\d+(?:\\.\\d+)?)$`));
  if (m) { const b = Number(m[1]); return { texto: `ITBMS (${TASA_ITBMS}%) de ${dinero(b)} = ${dinero(b * TASA_ITBMS / 100)}` }; }

  // — Porcentajes: "7% de 85", "85 más 10%", "85 menos 10%"
  m = r.match(/^(?:el\s+)?(\d+(?:\.\d+)?)%\s*de\s+(\d+(?:\.\d+)?)$/);
  if (m) return { texto: `${formatoNumero(Number(m[1]))}% de ${formatoNumero(Number(m[2]))} = ${formatoNumero(Number(m[2]) * Number(m[1]) / 100)}` };
  m = r.match(/^(\d+(?:\.\d+)?)\s*(mas|menos|\+|-)\s*(?:el\s+)?(\d+(?:\.\d+)?)%$/);
  if (m) {
    const b = Number(m[1]); const p = Number(m[3]); const delta = b * p / 100; const suma = m[2] === 'mas' || m[2] === '+';
    return { texto: `${formatoNumero(b)} ${suma ? '+' : '−'} ${formatoNumero(p)}% (${formatoNumero(delta)}) = ${formatoNumero(suma ? b + delta : b - delta)}` };
  }

  // — Operaciones: números y operadores
  let e = r;
  e = e.replace(/(\d),(\d{3})(?!\d)/g, '$1$2').replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2');
  if (esSuma) e = e.replace(/\s*,\s*/g, ' + ').replace(/\s+y\s+/g, ' + ');
  e = e.replace(/×/g, ' * ').replace(/÷/g, ' / ').replace(/−/g, ' - ')
    .replace(/(\d)\s*x\s*(?=\d)/g, '$1 * ')
    .replace(/\bmultiplicado por\b|\bmultiplicado\b|\bveces\b|\bpor\b/g, ' * ')
    .replace(/\bdividido entre\b|\bdividido por\b|\bdividido\b|\bentre\b/g, ' / ')
    .replace(/\bmas\b/g, ' + ').replace(/\bmenos\b/g, ' - ');
  e = e.replace(/\s+/g, ' ').trim();
  if (/[^0-9.+\-*/() ]/.test(e)) return null;                      // quedó alguna palabra suelta: no es (solo) un cálculo
  if (/\d\s*\/\s*\d/.test(e) && !/\s\/\s/.test(e) && !/dividid|entre|÷/.test(r + texto)) return null; // "22/10" es una fecha
  if (lead && /^\d+(?:\.\d+)?$/.test(e)) {                          // "cuánto es 20.12": un solo número (a veces la voz escribe "20 por 12" así)
    const dec = e.match(/^(\d+)\.(\d{1,2})$/);
    const pista = dec ? ` ¿Quisiste decir ${dec[1]} por ${dec[2]}? Escríbelo así: "${dec[1]} por ${dec[2]}".` : ' Dime la operación, por ejemplo: "15 por 12".';
    return { texto: `Eso es un solo número (${formatoNumero(Number(e))}), no una operación.${pista}` };
  }
  if (!/\d/.test(e) || !/[+\-*/]/.test(e.replace(/^-/, ''))) return null; // sin operación (un solo número, un teléfono…)
  if ((e.match(/\d+(?:\.\d+)?/g) || []).length < 2) return null;
  if (/\d\s+\d/.test(e)) return null;                              // "507 6029 1411": números pegados sin operador
  const compacta = e.replace(/\s+/g, '');
  const ev = evaluar(compacta);
  if (ev.error === 'cero') return { texto: 'No se puede dividir entre 0.' };
  if (ev.error || !Number.isFinite(ev.valor)) return null;
  return { texto: `${bonito(compacta)} = ${formatoNumero(ev.valor)}` };
}