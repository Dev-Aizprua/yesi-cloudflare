// functions/lib/calculo.js
// Motor de cálculo de fórmulas para los cuadros de Oficina IA.
// Groq NUNCA calcula montos — esta es la única fuente de verdad
// para interés, saldo, totales, etc.
//
// Usa expr-eval en vez de eval()/Function(): solo puede evaluar
// expresiones matemáticas, nunca código arbitrario.
//
// npm install expr-eval

import { Parser } from 'expr-eval';

const parser = new Parser();

/**
 * Aplica las reglas de cálculo de una plantilla sobre una fila.
 *
 * @param {Object} fila   - valores crudos de la fila, ej. { nombre: "Yisel", monto: 100, abono: 10 }
 * @param {Object} reglas - fórmulas en texto, EN ORDEN DE DEPENDENCIA.
 *   Ej: { interes: "monto * 0.10", saldo: "monto + interes - abono" }
 *   IMPORTANTE: "saldo" depende de "interes", así que "interes" debe
 *   declararse ANTES que "saldo" — las reglas se evalúan en el orden
 *   en que aparecen sus llaves en el objeto.
 * @returns {Object} la fila con los campos calculados agregados/actualizados
 */
export function calcularFila(fila, reglas) {
  const resultado = { ...fila };

  for (const [campo, formula] of Object.entries(reglas || {})) {
    try {
      const expr = parser.parse(formula);
      // Le pasamos como variables todo lo que ya conocemos: los
      // campos crudos de la fila + los ya calculados en este loop.
      // Si la fórmula pide una variable que todavía no existe (ej.
      // "abono" en un registro recién creado que aún no tiene
      // abonos), se asume 0 en vez de fallar — es el caso normal
      // de un registro nuevo, no un error real.
      const contextoConDefaultCero = new Proxy(resultado, {
        get(target, prop) {
          if (prop in target) return target[prop];
          return typeof prop === 'string' ? 0 : undefined;
        },
      });
      const valor = expr.evaluate(contextoConDefaultCero);

      if (typeof valor !== 'number' || Number.isNaN(valor)) {
        throw new Error(`La fórmula de "${campo}" no devolvió un número: ${valor}`);
      }

      // Redondeo a 2 decimales — evita el clásico 33.330000000000005
      resultado[campo] = Math.round(valor * 100) / 100;
    } catch (e) {
      // Si una fórmula falla, no rompemos el resto del cuadro — se
      // marca el campo como error explícito para que se note en la
      // imagen/panel, en vez de fallar silenciosamente con un número
      // incorrecto que el cliente podría no notar.
      console.log(`[CALCULO] Error evaluando "${campo}" = "${formula}":`, e.message);
      resultado[campo] = null;
      resultado._error_calculo = `${campo}: ${e.message}`;
    }
  }

  return resultado;
}

/**
 * Aplica calcularFila() a todas las filas de un cuadro.
 * Útil para recalcular todo de una vez (ej. al regenerar la imagen,
 * o si el cliente pide "revisa todo el cuadro").
 */
export function recalcularCuadro(filas, reglas) {
  return (filas || []).map(fila => calcularFila(fila, reglas));
}

/**
 * Valida que una fórmula tenga sintaxis correcta ANTES de guardarla
 * como parte de una plantilla nueva (herramienta crear_cuadro).
 * Así el error de un typo se detecta en el onboarding, no tres
 * semanas después cuando el cliente pregunte por qué el saldo
 * sale en blanco.
 *
 * @param {string} formula
 * @returns {{ valida: boolean, error: string|null }}
 */
export function validarFormula(formula) {
  try {
    parser.parse(formula);
    return { valida: true, error: null };
  } catch (e) {
    return { valida: false, error: e.message };
  }
}