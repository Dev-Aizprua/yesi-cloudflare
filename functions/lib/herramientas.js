// functions/lib/herramientas.js
// Las 8 herramientas (Tool Use) que Groq puede usar para modificar
// un cuadro. Formato compatible con la API de function calling de
// Groq/OpenAI (tools: [{ type: "function", function: {...} }]).
//
// Reglas que el modelo debe seguir SIEMPRE (reforzar también en el
// system prompt, no solo confiar en las descripciones de aquí):
//   1. Nunca calcula montos — solo extrae los valores crudos que
//      el usuario mencionó. El cálculo lo hace calculo.js.
//   2. Nunca decide a quién corresponde un nombre parecido — solo
//      extrae el nombre tal cual lo dijo el usuario. El match lo
//      hace buscarFila.js.
//   3. Si el negocio tiene un solo cuadro, "nombre_cuadro" puede
//      omitirse — el backend usa el único que existe. Si tiene
//      varios, el modelo debe inferirlo del contexto de la
//      conversación o preguntar si no es claro.

// Esquema de las líneas de una cotización / factura proforma (compartido por ambas herramientas)
const esquemaLineas = {
    type: 'array',
    description: 'Una entrada por cada producto o servicio de la cotización.',
    items: {
      type: 'object',
      properties: {
        descripcion: { type: 'string', description: 'Producto o servicio, tal cual lo dijo el usuario (ej. "sillas").' },
        cantidad: { type: ['string', 'null'], description: 'Cantidad tal cual se dijo (ej. "10"). Null/omitir si NO la dijo — nunca inventarla.' },
        precio: { type: ['string', 'null'], description: 'Precio UNITARIO tal cual se dijo (ej. "25"). Null/omitir si NO lo dijo — nunca inventarlo. Si el usuario da solo un total por la línea, no lo conviertas: déjalo null.' },
        itbms: {
          type: ['string', 'null'],
          description:
            'SOLO si el usuario dijo la tasa de ITBMS de esta línea, tal cual (ej. "10%", "15%", "exento"). ' +
            'Si NO la dijo, omitir/null — el sistema aplica 7%. Nunca la deduzcas por el tipo de producto.',
        },
      },
      required: ['descripcion'],
    },
  };

export const herramientas = [
  {
    type: 'function',
    function: {
      name: 'crear_cuadro',
      description:
        'Crea un cuadro NUEVO para este negocio, con su estructura de columnas y ' +
        'sus fórmulas de cálculo. Se usa SOLO cuando el negocio no tiene todavía ' +
        'ningún cuadro, o pide explícitamente uno adicional distinto a los que ya ' +
        'tiene (ej. "quiero llevar aparte mis gastos de gasolina"). NO se usa para ' +
        'agregar un registro a un cuadro que ya existe — para eso está agregar_fila.',
      parameters: {
        type: 'object',
        properties: {
          nombre_cuadro: {
            type: 'string',
            description: 'Nombre corto para identificar este cuadro, ej. "Préstamos" o "Gastos de gasolina".',
          },
          columnas: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lista de columnas del cuadro tal como el usuario las describió, ej. ["Nombre","Monto","Interés","Abono","Saldo"].',
          },
          reglas_calculo: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description:
              'Fórmulas de las columnas calculadas, como texto matemático, EN ORDEN DE DEPENDENCIA. ' +
              'Ej: {"interes": "monto * 0.10", "saldo": "monto + interes - abono"}. ' +
              'Si el usuario no da fórmulas explícitas, dejar este objeto vacío {} — no inventar fórmulas.',
          },
        },
        required: ['nombre_cuadro', 'columnas'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'agregar_fila',
      description:
        'Agrega un registro NUEVO a un cuadro que ya existe (ej. un cliente/préstamo nuevo). ' +
        'Usar solo los valores que el usuario mencionó explícitamente — no inventar ni ' +
        'completar campos que no dijo.',
      parameters: {
        type: 'object',
        properties: {
          nombre_cuadro: {
            type: ['string', 'null'],
            description: 'A qué cuadro pertenece. Omitir/null si el negocio solo tiene uno.',
          },
          nombre: {
            type: 'string',
            description: 'Nombre de la persona/registro nuevo, tal cual lo dijo el usuario (sin corregir ortografía).',
          },
          valores: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Los demás campos que el usuario mencionó, ej. {"monto": "100"}. Valores en texto tal cual se dijeron, sin calcular nada.',
          },
          telefono: {
            type: ['string', 'null'],
            description: 'Teléfono de contacto de esta persona, SOLO si el usuario lo dio en este mensaje. Omitir/null si no lo mencionó — nunca inventar uno.',
          },
        },
        required: ['nombre'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'generar_cobro',
      description:
        'Prepara mensaje(s) de cobro amables y enlace(s) de WhatsApp para que el USUARIO (el dueño del cuadro) ' +
        'se los reenvíe él mismo a quien le debe — el bot NUNCA le escribe directamente a los deudores. ' +
        'Tres modos: (1) UNA persona → usa "nombre". (2) VARIAS personas específicas, ej. "cóbrale a Juan, Pedro y ' +
        'Juana" → usa "nombres" (arreglo), deja "nombre" vacío. (3) Pedido genérico, ej. "dame la lista de cobros" ' +
        '→ deja "nombre" y "nombres" vacíos/null, se genera la lista de todos los que tienen saldo pendiente. ' +
        'Esta herramienta solo REDACTA mensajes de cobro; no sirve para consultar saldos.',
      parameters: {
        type: 'object',
        properties: {
          nombre_cuadro: {
            type: ['string', 'null'],
            description: 'A qué cuadro pertenece. Omitir/null si el negocio solo tiene uno.',
          },
          nombre: {
            type: ['string', 'null'],
            description: 'Modo UNA persona: su nombre tal cual lo dijo el usuario (sin corregir ortografía). Omitir/null en los otros dos modos.',
          },
          nombres: {
            type: ['array', 'null'],
            items: { type: 'string' },
            description: 'Modo VARIAS personas específicas: sus nombres tal cual los dijo el usuario, en una lista. Omitir/null en los otros dos modos.',
          },
          telefono: {
            type: ['string', 'null'],
            description:
              'SOLO aplica en modo UNA persona (parámetro "nombre"): el teléfono de esa persona, si el usuario lo ' +
              'mencionó en este mensaje o en uno reciente. Omitir/null si no lo dio, o si es modo lista — nunca inventar uno.',
          },
        },
        required: [],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'actualizar_fila',
      description:
        'Actualiza UN campo de un registro que ya existe en el cuadro (ej. "Yisel abonó 10" → ' +
        'campo="abono", valor="10"). Usar el nombre tal cual lo dijo el usuario, aunque no ' +
        'coincida exactamente con cómo está escrito en el cuadro — el backend se encarga de ' +
        'encontrar a quién corresponde.',
      parameters: {
        type: 'object',
        properties: {
          nombre_cuadro: {
            type: ['string', 'null'],
            description: 'A qué cuadro pertenece. Omitir/null si el negocio solo tiene uno.',
          },
          nombre: {
            type: 'string',
            description: 'Nombre mencionado por el usuario, TAL CUAL lo dijo (no corregir ni completar).',
          },
          campo: {
            type: 'string',
            description: 'Qué columna se está actualizando, ej. "abono".',
          },
          valor: {
            type: 'string',
            description: 'El valor crudo mencionado por el usuario, como texto (ej. "10"). No hacer ningún cálculo con él.',
          },
        },
        required: ['nombre', 'campo', 'valor'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'eliminar_fila',
      description:
        'Elimina un registro del cuadro por completo — ej. préstamo saldado y cerrado, ' +
        'o un cliente que ya no aplica. Usar con cuidado: solo cuando el usuario pide ' +
        'explícitamente quitar/cerrar/eliminar a alguien, nunca por inferencia propia.',
      parameters: {
        type: 'object',
        properties: {
          nombre_cuadro: {
            type: ['string', 'null'],
            description: 'A qué cuadro pertenece. Omitir/null si el negocio solo tiene uno.',
          },
          nombre: {
            type: 'string',
            description: 'Nombre mencionado por el usuario, tal cual lo dijo.',
          },
        },
        required: ['nombre'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'consultar_cuadro',
      description:
        'Para cuando el usuario solo quiere VER información sin modificar nada — ej. ' +
        '"¿cómo va el cuadro?", "mándame la imagen actualizada". ' +
        'IMPORTANTE: usar esta herramienta (no actualizar_fila) siempre que la intención sea ' +
        'de solo lectura, para no arriesgarse a modificar algo por error.',
      parameters: {
        type: 'object',
        properties: {
          nombre_cuadro: {
            type: ['string', 'null'],
            description: 'A qué cuadro se refiere. Omitir/null si el negocio solo tiene uno, o si pregunta por todos.',
          },
          nombre: {
            type: ['string', 'null'],
            description:
              'Si la pregunta es sobre UNA persona/registro específico (ej. "¿cuánto debe Rogelio?"), ' +
              'el nombre tal cual lo dijo el usuario, SIN corregir ni decidir a quién se refiere — el backend ' +
              'hace el match. Omitir/null si la pregunta es sobre el cuadro en general (ej. "¿cómo va todo?").',
          },
        },
        required: [],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'enviar_excel',
      description:
        'Envía al usuario el cuadro como archivo Excel (.xlsx) con fórmulas reales. ' +
        'Úsala SOLO cuando el usuario pida explícitamente el Excel, la hoja de cálculo o el archivo. ' +
        'Para ver el cuadro como imagen usa consultar_cuadro.',
      parameters: {
        type: 'object',
        properties: {
          nombre_cuadro: {
            type: ['string', 'null'],
            description: 'A qué cuadro se refiere. Omitir/null si el negocio solo tiene uno.',
          },
          con_imagen: {
            type: ['boolean', 'null'],
            description: 'true SOLO si el usuario pidió también la imagen del cuadro, además del Excel. Omitir/null en los demás casos.',
          },
        },
        required: [],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'generar_carta',
      description:
        'Genera un documento Word (carta de solicitud, poder simple, u otro tipo del catálogo — ver la ' +
        'lista de cartas disponibles en el system prompt) con los datos que el usuario dictó. Úsala cuando ' +
        'el usuario pida redactar/generar una carta, documento, solicitud o poder — NO para cobros ' +
        '(generar_cobro) ni para el cuadro de negocio (enviar_excel/consultar_cuadro). Extrae SOLO los ' +
        'datos que el usuario mencionó explícitamente; si falta algo obligatorio, el backend se encarga de ' +
        'preguntarlo — nunca inventes ni completes un dato que no dijo.',
      parameters: {
        type: 'object',
        properties: {
          tipo_carta: {
            type: ['string', 'null'],
            description:
              'El "id" EXACTO de la plantilla elegida, tomado del catálogo de cartas disponibles del ' +
              'system prompt (ej. "solicitud_generica"). Null si el usuario no fue claro sobre qué tipo ' +
              'de carta quiere, o si no hay ninguna en el catálogo que calce con lo que pide.',
          },
          campos: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description:
              'Los datos que el usuario dictó para esta carta, usando como clave el "id" EXACTO de cada ' +
              'campo (tomado del catálogo del system prompt para esta plantilla), y como valor el texto tal ' +
              'cual lo dijo, sin corregir. Omitir por completo los campos que el usuario no mencionó — nunca ' +
              'usar un id que no esté en el catálogo de esa plantilla.',
          },
        },
        required: [],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'crear_cotizacion',
      description:
        'Arma una COTIZACIÓN nueva con lo que el usuario dictó (ej. "hazme una cotización para Juan, 10 sillas a $25"). ' +
        'Úsala cuando pida una cotización o presupuesto para un cliente. NO es para facturas ya emitidas ni para ' +
        'cuadros de préstamos. Extrae SOLO lo que el usuario dijo, tal cual: NUNCA calcules totales, subtotal ni ITBMS — ' +
        'el sistema los calcula. El backend le muestra el resultado al usuario para que lo confirme antes de guardarlo.',
      parameters: {
        type: 'object',
        properties: {
          cliente: {
            type: ['string', 'null'],
            description: 'Nombre del cliente tal cual lo dijo el usuario. Null/omitir si no lo dijo.',
          },
          lineas: esquemaLineas,
          validez: {
            type: ['string', 'null'],
            description: 'Validez de la oferta si el usuario la dijo (ej. "15 días"). Null/omitir si no.',
          },
        },
        required: ['lineas'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'crear_factura_proforma',
      description:
        'Arma una FACTURA PROFORMA nueva con lo que el usuario dictó (ej. "hazme una factura para Juan, 10 sillas a $25"). ' +
        'Úsala cuando pida una factura, una factura proforma o una nota de cobro para un cliente — el sistema NO emite ' +
        'facturas fiscales, así que todo pedido de factura se resuelve con esta herramienta. NO es para cotizaciones ' +
        '(crear_cotizacion) ni para cuadros de préstamos. Extrae SOLO lo que el usuario dijo, tal cual: NUNCA calcules ' +
        'totales, subtotal ni ITBMS — el sistema los calcula. El backend le muestra el resultado al usuario para que ' +
        'lo confirme antes de guardarlo.',
      parameters: {
        type: 'object',
        properties: {
          cliente: {
            type: ['string', 'null'],
            description: 'Nombre del cliente tal cual lo dijo el usuario. Null/omitir si no lo dijo.',
          },
          lineas: esquemaLineas,
          condicion_pago: {
            type: ['string', 'null'],
            description: 'Condición de pago si el usuario la dijo (ej. "contado", "30 días"). Null/omitir si no.',
          },
        },
        required: ['lineas'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'convertir_cotizacion_en_factura',
      description:
        'Convierte una COTIZACIÓN que YA EXISTE en una factura proforma nueva (ej. "hazme la factura de la cotización 004", ' +
        '"pasa la cotización de Juan a factura"). Copia el cliente, las líneas y las tasas de ITBMS; la factura proforma ' +
        'lleva su propio número y la fecha de hoy. Úsala SOLO cuando el usuario se refiere a una cotización ya guardada. ' +
        'Si pide una factura desde cero, con productos que dicta ahora, usa crear_factura_proforma. No calcules nada.',
      parameters: {
        type: 'object',
        properties: {
          nombre_cuadro: {
            type: ['string', 'null'],
            description:
              'La cotización a convertir, tal cual la dijo el usuario (ej. "Cotización 004", "004" o el nombre completo). ' +
              'Si dijo "la última", poner "la última". Null/omitir si no dijo cuál.',
          },
          condicion_pago: {
            type: ['string', 'null'],
            description: 'Condición de pago si el usuario la dijo (ej. "contado", "30 días"). Null/omitir si no.',
          },
        },
        required: [],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'registrar_pago',
      description:
        'Registra un PAGO o ABONO que un cliente hizo de una FACTURA PROFORMA (ej. "Juan pagó 100", "Ana abonó 50 de la factura 004", ' +
        '"Juan pagó 100 ayer"). Extrae SOLO lo que el usuario dijo, tal cual: NUNCA calcules saldos ni decidas a qué factura corresponde — ' +
        'el sistema lo hace y le muestra al usuario el efecto para que lo confirme antes de guardar. ' +
        'NO es para abonos de un cuadro de préstamos ni de ningún otro cuadro (para eso usa actualizar_fila), ni para crear facturas.',
      parameters: {
        type: 'object',
        properties: {
          cliente: {
            type: ['string', 'null'],
            description: 'Nombre de quien pagó, tal cual lo dijo el usuario. Null/omitir si no lo dijo.',
          },
          monto: {
            type: 'string',
            description: 'Monto pagado, tal cual se dijo (ej. "100", "$50.25"). No lo calcules ni lo redondees.',
          },
          numero_documento: {
            type: ['string', 'null'],
            description: 'Número de la factura SOLO si el usuario lo dijo (ej. "004"). Null/omitir si no lo dijo — nunca lo adivines.',
          },
          fecha: {
            type: ['string', 'null'],
            description: 'Fecha del pago SOLO si el usuario la dijo, tal cual (ej. "ayer", "28/09/2026"). Null/omitir si no la dijo (el sistema usa hoy).',
          },
        },
        required: ['monto'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'ajustar_pago',
      description:
        'Corrige PAGOS y FACTURAS ya registrados, con una "accion": ' +
        '"anular_pago" (anular un pago registrado, ej. "anula el pago de Ana", "me equivoqué con el pago de Juan"); ' +
        '"anular_documento" (anular una factura o cotización, ej. "anula la factura 004"); ' +
        '"aplicar_saldo_a_favor" (aplicar a una factura el dinero que un cliente tiene a favor, ej. "aplica el saldo a favor de Ana a la factura 004"). ' +
        'Extrae SOLO lo que el usuario dijo, tal cual: NUNCA calcules ni decidas cuál pago o factura es — el sistema pregunta y pide confirmación. ' +
        '"Anular" NO es "eliminar el cuadro" (eso es eliminar_cuadro) ni registrar un pago nuevo (eso es registrar_pago).',
      parameters: {
        type: 'object',
        properties: {
          accion: { type: 'string', enum: ['anular_pago', 'anular_documento', 'aplicar_saldo_a_favor'], description: 'Qué quiere hacer el usuario.' },
          cliente: { type: ['string', 'null'], description: 'Cliente, tal cual lo dijo. Null/omitir si no lo dijo.' },
          monto: { type: ['string', 'null'], description: 'Monto SOLO si lo dijo, tal cual (para elegir el pago o limitar cuánto saldo aplicar). Null/omitir si no.' },
          numero_documento: { type: ['string', 'null'], description: 'Número de factura/cotización SOLO si lo dijo (ej. "004"). Nunca lo adivines.' },
          tipo_documento: { type: ['string', 'null'], description: 'Solo para anular_documento: "factura" o "cotizacion", según la palabra que usó el usuario.' },
          fecha: { type: ['string', 'null'], description: 'Fecha del pago SOLO si la dijo, tal cual (ej. "ayer", "28/09/2026"). Null/omitir si no.' },
        },
        required: ['accion'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'enviar_pdf',
      description:
        'Envía al usuario el documento o cuadro como archivo PDF (cotización, factura proforma o cualquier cuadro). ' +
        'Úsala SOLO cuando el usuario pida el PDF. Para el Excel usa enviar_excel; para verlo como imagen usa consultar_cuadro.',
      parameters: {
        type: 'object',
        properties: {
          nombre_cuadro: {
            type: ['string', 'null'],
            description: 'A qué cuadro o documento se refiere, tal cual lo dijo el usuario (ej. "Cotización 004" o "Factura proforma 003 - Ana"). Omitir/null si el negocio solo tiene uno.',
          },
        },
        required: [],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'eliminar_cuadro',
      description:
        'Elimina un cuadro COMPLETO (todas sus columnas, fórmulas y registros) — acción ' +
        'irreversible. Úsala SOLO cuando el usuario pida explícitamente borrar/eliminar un ' +
        'cuadro entero (no un registro individual — para eso está eliminar_fila). El backend ' +
        'siempre pedirá confirmación explícita antes de borrar de verdad, así que puedes ' +
        'llamar esta herramienta directamente sin pedir tú la confirmación.',
      parameters: {
        type: 'object',
        properties: {
          nombre_cuadro: {
            type: ['string', 'null'],
            description: 'Qué cuadro eliminar. Omitir/null si el negocio solo tiene uno.',
          },
        },
        required: [],
      },
    },
  },
];

/**
 * Devuelve solo los nombres de las herramientas — útil para
 * validar en el webhook que la respuesta de Groq usó un nombre
 * de función que realmente existe.
 */
export const NOMBRES_HERRAMIENTAS = herramientas.map(h => h.function.name);