// functions/lib/fechasCarta.js
// Las fechas numéricas que dicta la gente ("15/11/2026", "3-10-2026") se escriben en letras
// en las cartas ("15 de noviembre de 2026"). Formato de Panamá: día/mes/año. Es solo
// presentación: si la fecha no es válida (ej. 31/02/2026 o 15/13/2026) se deja tal cual.

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function fechaNumericaEnLetras(texto) {
  return String(texto ?? '').replace(/(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?![\d/.-])/g, (orig, d, m, a) => {
    const dia = Number(d), mes = Number(m), anio = Number(a);
    if (mes < 1 || mes > 12 || dia < 1 || anio < 1900 || anio > 2100) return orig;
    const maxDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
    if (dia > maxDia) return orig;
    return `${dia} de ${MESES[mes - 1]} de ${anio}`;
  });
}

// Copia de los campos de una carta con las fechas numéricas en letras (no modifica el original).
export function camposConFechasEnLetras(campos) {
  const salida = {};
  for (const [k, v] of Object.entries(campos || {})) {
    // Las cédulas (ej. 8-12-1985) tienen forma de fecha: nunca se tocan.
    salida[k] = typeof v === 'string' && !/ced|ruc|doc/i.test(k) ? fechaNumericaEnLetras(v) : v;
  }
  return salida;
}