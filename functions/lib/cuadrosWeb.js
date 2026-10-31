// functions/lib/cuadrosWeb.js
// Cuadros en la oficina web (SOLO LECTURA). Lee lo mismo que el bot y arma la tabla con el MISMO cálculo que
// los archivos que genera (calculo.js y tablaExtendida.js), para que web, Excel y PDF digan lo mismo.
// El negocio sale de la sesión; un cuadro de otro negocio responde "no existe".

import { recalcularCuadro } from './calculo.js';
import { recalcularPie } from './tablaExtendida.js';
import { redondear2 } from './pagos.js';

const MAX_FILAS_VISTA = 500;

// Igual que aClave de excelCuadro.js: la clave interna de cada columna
export function aClave(texto) {
  return String(texto).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '_');
}

const parse = (txt, defecto) => { try { return JSON.parse(txt || ''); } catch { return defecto; } };

export async function listarCuadros(db, negocioId) {
  const { results } = await db.prepare(
    'SELECT id, nombre_cuadro, estructura, filas, actualizado_en, created_at FROM cuadros WHERE negocio_id = ? ORDER BY COALESCE(actualizado_en, created_at) DESC, id DESC LIMIT 200'
  ).bind(negocioId).all();
  return results.map(c => {
    const est = parse(c.estructura, {});
    const filas = parse(c.filas, []);
    return {
      id: c.id, nombre: c.nombre_cuadro,
      tipo: est.tipo === 'secciones' ? 'secciones' : 'tabla',
      nFilas: Array.isArray(filas) ? filas.length : 0,
      actualizado: String(c.actualizado_en || c.created_at || '').slice(0, 10) || null,
    };
  });
}

/** Cuadro completo del negocio (o null si no existe o es de otro negocio). */
export async function cargarCuadro(db, negocioId, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const c = await db.prepare('SELECT * FROM cuadros WHERE id = ? AND negocio_id = ?').bind(n, negocioId).first();
  if (!c) return null;
  const estructura = parse(c.estructura, {});
  return {
    id: c.id, nombre: c.nombre_cuadro, estructura,
    columnas: estructura.columnas || [],
    reglas: estructura.reglas_calculo || {},
    subtitulo: estructura.subtitulo || null,
    extras: { encabezado: estructura.encabezado || [], pie: estructura.pie || [] },
    filas: parse(c.filas, []),
    actualizado: String(c.actualizado_en || c.created_at || '').slice(0, 10) || null,
  };
}

/** Lo que ve la pantalla: columnas, filas ya calculadas, totales (igual que el Excel) y, si es factura, encabezado y pie. */
export function vistaCuadro(c) {
  if (c.estructura.tipo === 'secciones') {
    return { id: c.id, nombre: c.nombre, tipo: 'secciones', descargable: false, actualizado: c.actualizado };
  }
  const columnas = c.columnas;
  const claves = columnas.map(aClave);
  let calculadas = Array.isArray(c.filas) ? c.filas : [];
  try { calculadas = recalcularCuadro(calculadas, c.reglas || {}); } catch (e) { console.log('[WEB] cuadro sin recalcular:', e?.message); }
  const hayPie = (c.extras.pie || []).length > 0;

  const filas = calculadas.slice(0, MAX_FILAS_VISTA).map(f => claves.map(k => {
    const v = f?.[k];
    return v === undefined || v === null ? '' : v;
  }));

  let totales = null;
  if (!hayPie && calculadas.length > 0) {
    totales = claves.map((k, j) => {
      if (j === 0) return 'Total';
      const todas = calculadas.every(f => typeof f?.[k] === 'number' && Number.isFinite(f[k]));
      return todas ? redondear2(calculadas.reduce((s, f) => s + f[k], 0)) : '';
    });
  }

  let pie = null;
  if (hayPie) {
    let filasPie = c.extras.pie;
    try { filasPie = recalcularPie(c.extras.pie, claves, calculadas); } catch (e) { console.log('[WEB] pie sin recalcular:', e?.message); }
    pie = filasPie.map(p => ({ etiqueta: String(p.etiqueta ?? ''), valor: p.pendiente || p.valor === null || p.valor === undefined ? null : p.valor }));
  }
  const encabezado = (c.extras.encabezado || []).map(e => ({
    etiqueta: String(e.etiqueta ?? ''),
    valor: e.pendiente || e.valor === null || e.valor === undefined || String(e.valor).trim() === '' ? null : String(e.valor),
  }));

  return {
    id: c.id, nombre: c.nombre, tipo: 'tabla', descargable: true, actualizado: c.actualizado,
    subtitulo: c.subtitulo, columnas, filas, nFilas: calculadas.length, recortado: calculadas.length > MAX_FILAS_VISTA,
    totales, encabezado, pie,
  };
}