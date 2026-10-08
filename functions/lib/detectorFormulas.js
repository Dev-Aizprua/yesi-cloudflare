// functions/lib/detectorFormulas.js
// Detector de fórmulas para cuadros importados desde una foto.
//
// Cuando alguien manda la foto de un cuadro en papel/Excel, la IA de
// visión SOLO transcribe columnas y valores — igual que Groq nunca
// calcula montos al recibir un mensaje de texto. Este archivo es la
// única pieza que decide qué columna se explica con cuáles otras, en
// JavaScript puro, comparando los números que ya se transcribieron.
//
// REGLA CLAVE para evitar ambigüedad: una columna solo puede
// definirse usando columnas que aparezcan ANTES que ella, en el
// mismo orden en que aparecen en la foto (de izquierda a derecha).
// Sin esta regla, el detector encuentra fórmulas matemáticamente
// válidas pero conceptualmente invertidas (ej. "monto = interes /
// 0.10", cuando en realidad Monto es el dato que el cliente anotó a
// mano y el Interés es el resultado). Es la misma convención que ya
// usa calculo.js: "reglas_calculo... EN ORDEN DE DEPENDENCIA".
//
// Probado contra un cuadro real de préstamos (11 filas, incluida una
// en $0.00): detecta correctamente "interes = monto * 0.1" y
// "saldo = monto - abono_a_capital", y deja Monto y Abono como datos
// crudos.
//
// Probado además (26 sept) contra un paquete de 12 modelos de cuadros
// reales (Planilla, Facturación, Inventario, Ventas Diarias, Cuentas
// por Cobrar, Ingresos y Gastos). De ahí salieron 2 huecos reales,
// ya corregidos aquí:
//   1. "Cierre = Efectivo + Yappy + Tarjeta - Gastos" (4 términos) no
//      se detectaba — el límite estaba en 3. Ahora en 4.
//   2. "Bruto = Horas * Tarifa" (dos columnas que varían, no una tasa
//      fija) no se detectaba, Y PEOR: con pocas filas de ejemplo
//      podía salir una fórmula FALSA por coincidencia (ej. si dos
//      empleados comparten las mismas horas, "tarifa * 80" parece
//      una tasa válida sin serlo). Se agregó intentarProducto(), que
//      se prueba ANTES que la tasa de una sola columna — así, cuando
//      la relación real es "columna × columna", el detector la
//      encuentra primero y nunca llega a la coincidencia que lo
//      engañaba. Mismo patrón sirve para "Cantidad × Precio Unit."
//      en facturas/cotizaciones, uno de los formatos más comunes.

function esNumero(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// COLUMNAS DE NUMERACIÓN ("#", "No.", "Ítem"...): valen 1, 2, 3... y
// no significan nada como cantidad. Con una factura real de 2 líneas
// (cantidades 1 y 2) el detector inventó "total = numero * p_unitario"
// en vez de "cant * p_unitario", solo porque el número de línea
// coincidía con la cantidad — y con esa fórmula guardada, cambiar la
// cantidad ya no recalculaba el total. Se excluyen SOLO si el NOMBRE
// es de numeración Y los valores son exactamente n, n+1, n+2... (así
// una columna real "Cant." con 1, 2, 3 no se descarta). Excluir de
// más es el lado seguro: la columna queda con valores fijos, nunca
// con una fórmula falsa. Nota: normalizarClave("#") da "" (vacío), por
// eso "" cuenta como nombre de numeración.
const NOMBRES_DE_NUMERACION = new Set(['', 'n', 'no', 'nro', 'num', 'numero', 'item', 'linea', 'id']);

function esColumnaDeNumeracion(clave, filas) {
  if (!NOMBRES_DE_NUMERACION.has(clave)) return false;
  return filas.every((f, i) => f[clave] === filas[0][clave] + i);
}

// Con menos filas que esto, "columna × tasa" y "suma/resta" pueden
// aparecer por pura coincidencia (con 1 fila CUALQUIER razón encaja
// por construcción). "columna × columna" no tiene ese problema — no
// hay una constante que se derive de la misma fila — y ya exige que
// el resultado sea único, así que se permite con menos filas (una
// factura de 1 o 2 líneas es normal).
const MIN_FILAS_TASA_Y_SUMA = 3;

function intentarTasa(objetivo, candidata, filas, tol = 0.03) {
  const pares = filas.map(f => [f[candidata], f[objetivo]]).filter(([a]) => esNumero(a) && a !== 0);
  if (pares.length < 2) return null;
  const tasa = Math.round((pares[0][1] / pares[0][0]) * 100) / 100;
  if (tasa === 0) return null;
  for (const f of filas) {
    const esperado = Math.round(f[candidata] * tasa * 100) / 100;
    if (Math.abs(esperado - f[objetivo]) > tol) return null;
  }
  return { formula: `${candidata} * ${tasa}`, tipo: 'tasa' };
}

// "columna × columna" — ej. Bruto = Horas * Tarifa, Total = Cantidad
// * Precio Unitario. Distinto de intentarTasa: aquí NINGUNA de las
// dos columnas es una constante, las dos varían fila a fila.
// Devuelve TODOS los pares que explican la columna (no solo el
// primero): si hay más de uno, el detector no adivina cuál es el bueno
// (ver detectarFormulas).
function intentarProducto(objetivo, candidatas, filas, tol = 0.03) {
  const hallazgos = [];
  for (let i = 0; i < candidatas.length; i++) {
    for (let j = i + 1; j < candidatas.length; j++) {
      const [a, b] = [candidatas[i], candidatas[j]];
      const ok = filas.every(f => {
        if (!esNumero(f[a]) || !esNumero(f[b])) return false;
        return Math.abs(Math.round(f[a] * f[b] * 100) / 100 - f[objetivo]) <= tol;
      });
      if (ok) hallazgos.push({ formula: `${a} * ${b}`, tipo: 'producto' });
    }
  }
  return hallazgos;
}

function intentarSumaResta(objetivo, candidatas, filas, maxTerminos = 4, tol = 0.03) {
  function* combinaciones(arr, k) {
    if (k === 0) { yield []; return; }
    for (let i = 0; i <= arr.length - k; i++) {
      for (const resto of combinaciones(arr.slice(i + 1), k - 1)) yield [arr[i], ...resto];
    }
  }
  for (let k = 1; k <= Math.min(maxTerminos, candidatas.length); k++) {
    for (const combo of combinaciones(candidatas, k)) {
      for (let m = 0; m < Math.pow(2, combo.length); m++) {
        const signos = combo.map((_, i) => ((m >> i) & 1 ? -1 : 1));
        const ok = filas.every(f => {
          let suma = 0;
          for (let i = 0; i < combo.length; i++) suma += signos[i] * f[combo[i]];
          return Math.abs(Math.round(suma * 100) / 100 - f[objetivo]) <= tol;
        });
        if (ok) {
          const expr = combo
            .map((c, i) => (i === 0 ? (signos[i] < 0 ? '-' : '') : signos[i] < 0 ? ' - ' : ' + ') + c)
            .join('');
          return { formula: expr, tipo: 'suma_resta' };
        }
      }
    }
  }
  return null;
}

/**
 * @param {string[]} columnas  claves internas, EN EL ORDEN en que aparecen en la foto/cuadro
 * @param {Object[]} filas     valores ya transcritos (sin la fila de "Total", si la hay)
 * @returns {Object} { [columna]: { formula, tipo } } — solo para las columnas que se pudieron explicar
 */
export function detectarFormulas(columnas, filas) {
  if (!filas || filas.length === 0) return {};
  const numericas = columnas.filter(
    c => filas.every(f => esNumero(f[c])) && !esColumnaDeNumeracion(c, filas)
  );
  const resultado = {};
  numericas.forEach((objetivo, idx) => {
    const anteriores = numericas.slice(0, idx);
    if (anteriores.length === 0) return; // primera columna numérica: siempre es un dato crudo

    // Orden de pruebas: producto de 2 columnas PRIMERO — si la
    // relación real es "columna × columna", encontrarla aquí evita
    // que una coincidencia de pocas filas dispare un falso "× tasa
    // fija" más abajo (ver nota de la cabecera).
    const productos = intentarProducto(objetivo, anteriores, filas);
    if (productos.length > 1) return; // ambiguo: más de un par encaja — no se adivina, queda dato fijo
    let hallazgo = productos[0] || null;

    if (!hallazgo && filas.length >= MIN_FILAS_TASA_Y_SUMA) {
      for (const candidata of anteriores) {
        hallazgo = intentarTasa(objetivo, candidata, filas);
        if (hallazgo) break;
      }
      if (!hallazgo) hallazgo = intentarSumaResta(objetivo, anteriores, filas);
    }
    if (hallazgo) resultado[objetivo] = hallazgo;
  });
  return resultado;
}

/**
 * Compara la suma de cada columna numérica contra la fila de "Total"
 * que trae la foto (si la trae). Es la red de seguridad contra
 * errores de lectura: si la IA de visión confundió un número, la
 * suma ya no cuadra y se detecta ANTES de guardar nada.
 *
 * @param {string[]} columnas
 * @param {Object[]} filas
 * @param {Object|null} filaTotales  valores de la fila "Total" ya transcritos, o null si la foto no traía una
 * @returns {{ tieneFilaTotales: boolean, coincide: boolean, detalles: Object[] }}
 */
export function validarContraTotales(columnas, filas, filaTotales) {
  if (!filaTotales) return { tieneFilaTotales: false, coincide: true, detalles: [] };

  const numericas = columnas.filter(c => filas.every(f => esNumero(f[c])) && esNumero(filaTotales[c]));
  const detalles = [];
  for (const c of numericas) {
    const sumaCalculada = Math.round(filas.reduce((a, f) => a + f[c], 0) * 100) / 100;
    const totalFoto = filaTotales[c];
    if (Math.abs(sumaCalculada - totalFoto) > 0.03) {
      detalles.push({ columna: c, sumaCalculada, totalFoto });
    }
  }
  return { tieneFilaTotales: true, coincide: detalles.length === 0, detalles };
}