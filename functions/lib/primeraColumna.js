// functions/lib/primeraColumna.js
// CUADROS CUYA PRIMERA COLUMNA NO SE LLAMA "Nombre" (Planta, Producto, Cliente...).
// Las filas guardan el nombre en la clave "nombre" (la que lee buscarFila), pero la imagen, el Excel y la web
// muestran cada columna leyendo la clave que sale de su título ("planta"). Para que el nombre se vea, la fila
// lleva el nombre bajo las DOS claves (así ya lo hace la carga de varias filas en cargaFilasTexto.js).
// Funciones PURAS, sin base de datos.

/** Clave de la primera columna (la del nombre). Sin columnas, "nombre". */
export function claveDeLaPrimeraColumna(columnas, normalizarClave) {
  const primera = Array.isArray(columnas) ? columnas[0] : null;
  return primera ? normalizarClave(primera) : 'nombre';
}

/** Copia de la fila con el nombre también bajo la clave de la primera columna. */
export function conNombreEnPrimeraColumna(fila, clave) {
  if (!fila || !clave || clave === 'nombre') return fila;
  const nombre = fila.nombre ?? fila[clave];
  if (nombre === undefined || nombre === null || nombre === '') return fila;
  if (fila.nombre === nombre && fila[clave] === nombre) return fila;
  return { ...fila, nombre, [clave]: nombre };
}

/** Completa EN SITIO las filas viejas que tienen "nombre" pero no la clave de la primera columna. Devuelve cuántas completó. */
export function sanarNombresEnPrimeraColumna(filas, clave) {
  if (!Array.isArray(filas) || !clave || clave === 'nombre') return 0;
  let n = 0;
  filas.forEach((f, i) => {
    if (!f || typeof f !== 'object') return;
    const falta = f[clave] === undefined || f[clave] === null || f[clave] === '';
    if (falta && f.nombre !== undefined && f.nombre !== null && f.nombre !== '') { filas[i] = { ...f, [clave]: f.nombre }; n++; }
  });
  return n;
}

/** Tras cambiar un campo de una fila: si fue el nombre (o la primera columna), la otra clave se actualiza igual. */
export function sincronizarNombreTrasCambio(fila, clave, campoCambiado) {
  if (!fila || !clave || clave === 'nombre') return fila;
  if (campoCambiado === 'nombre') return { ...fila, [clave]: fila.nombre };
  if (campoCambiado === clave) return { ...fila, nombre: String(fila[clave] ?? '').trim() };
  return fila;
}