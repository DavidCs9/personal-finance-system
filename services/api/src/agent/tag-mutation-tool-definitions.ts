export const TAG_MUTATION_TOOL_DEFINITIONS = [
  {
    name: 'preview_tag_edit',
    description: [
      'Es un dry run que congela movimientos accepted exactos antes de cambiar tags y devuelve affected completo, no sólo una muestra.',
      'Usa eventIds cuando ya identificaste movimientos concretos con list_movements; acepta IDs de fechas distintas. También acepta un rango sólo si lleva merchantRaw exacto, sourceTags u onlyUntagged=true. Nunca llames esta tool con sólo fechas.',
      'Revisa todos los afectados antes de apply. La instrucción explícita del usuario en el chat autoriza el cambio: después de recibir operationId debes llamar apply_tag_edit o apply_tag_edits inmediatamente en el mismo turno, sin pedir confirmación en la UI.',
      'Sólo modifica tags; nunca categorías.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        fromDay: { type: 'string', description: 'Inicio inclusivo YYYY-MM-DD. Requerido para selector por rango.' },
        toDay: { type: 'string', description: 'Fin inclusivo YYYY-MM-DD. Requerido junto con fromDay.' },
        addTags: { type: 'array', items: { type: 'string' }, description: 'Tags que se agregarán.' },
        removeTags: { type: 'array', items: { type: 'string' }, description: 'Tags que se quitarán.' },
        eventId: { type: 'string', description: 'ID exacto de un movimiento. Alternativa breve a eventIds para un solo movimiento.' },
        eventIds: { type: 'array', items: { type: 'string' }, description: 'IDs exactos de movimientos; 1–49, únicos. Puede usarse sin fechas.' },
        merchantRaw: { type: 'string', description: 'Comercio exacto a filtrar dentro del rango; compara sin mayúsculas, acentos ni espacios extra.' },
        sourceTags: { type: 'array', items: { type: 'string' }, description: 'Sólo cambia movimientos que aún contienen todos estos tags.' },
        onlyUntagged: { type: 'boolean', description: 'Sólo cambia movimientos que aún no tienen tags. No combinar con sourceTags.' },
      },
    },
  },
  {
    name: 'apply_tag_edit',
    description: [
      'Aplica exactamente el snapshot congelado por preview_tag_edit y crea una revisión auditable por movimiento.',
      'Sólo acepta el operationId devuelto por preview_tag_edit; nunca inventes uno.',
      'Llámala inmediatamente después del preview en el mismo turno. No pidas confirmación adicional.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        operationId: { type: 'string', description: 'operationId devuelto por preview_tag_edit.' },
      },
      required: ['operationId'],
    },
  },
  {
    name: 'undo_tag_edit',
    description: [
      'Deshace una edición de tags aplicada por el asistente usando su operationId.',
      'Úsala cuando el usuario pida deshacer esa edición; no pidas confirmación adicional.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        operationId: { type: 'string', description: 'operationId de la edición aplicada.' },
      },
      required: ['operationId'],
    },
  },
  {
    name: 'apply_tag_edits',
    description: [
      'Aplica atómicamente varias operaciones tags-only pendientes en una sola transacción DynamoDB.',
      'Úsala para varios previews concretos cuando el total cabe en la transacción; recibe 1–12 operationIds reales y devuelve un recibo por operación.',
      'No mezcles operaciones de categorías ni inventes IDs. No pidas confirmación adicional.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        operationIds: { type: 'array', items: { type: 'string' }, description: 'operationIds de previews tags-only pendientes.' },
      },
      required: ['operationIds'],
    },
  },
  {
    name: 'preview_category_edit',
    description: [
      'Es un dry run que congela movimientos accepted exactos antes de cambiar su categoría y devuelve affected completo, no sólo una muestra.',
      'Usa eventIds cuando ya identificaste movimientos concretos con list_movements; acepta IDs de fechas distintas. También acepta un rango sólo si lleva merchantRaw exacto, sourceCategoryId o onlyUncategorized=true. Nunca llames esta tool con sólo fechas.',
      'Revisa todos los afectados antes de apply. La instrucción explícita del usuario en el chat autoriza el cambio: después de recibir operationId debes llamar apply_category_edit o apply_category_edits inmediatamente en el mismo turno, sin pedir confirmación en la UI.',
      'Sólo modifica categoryId; nunca tags ni reglas de comercio.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        fromDay: { type: 'string', description: 'Inicio inclusivo YYYY-MM-DD. Requerido para selector por rango.' },
        toDay: { type: 'string', description: 'Fin inclusivo YYYY-MM-DD. Requerido junto con fromDay.' },
        categoryId: { type: 'string', description: 'ID de categoría destino del catálogo de Olbia.' },
        eventId: { type: 'string', description: 'ID exacto de un movimiento. Alternativa breve a eventIds para un solo movimiento.' },
        eventIds: { type: 'array', items: { type: 'string' }, description: 'IDs exactos de movimientos; 1–49, únicos. Puede usarse sin fechas.' },
        merchantRaw: { type: 'string', description: 'Comercio exacto a filtrar dentro del rango; compara sin mayúsculas, acentos ni espacios extra.' },
        sourceCategoryId: { type: 'string', description: 'Sólo cambia movimientos que aún tienen esta categoría actual.' },
        onlyUncategorized: { type: 'boolean', description: 'Sólo cambia movimientos que aún no tienen categoría. No combinar con sourceCategoryId.' },
      },
      required: ['categoryId'],
    },
  },
  {
    name: 'apply_category_edit',
    description: [
      'Aplica exactamente el snapshot congelado por preview_category_edit y crea una revisión auditable por movimiento.',
      'Sólo acepta el operationId devuelto por preview_category_edit; nunca inventes uno.',
      'Llámala inmediatamente después del preview en el mismo turno. No pidas confirmación adicional.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        operationId: { type: 'string', description: 'operationId devuelto por preview_category_edit.' },
      },
      required: ['operationId'],
    },
  },
  {
    name: 'undo_category_edit',
    description: [
      'Deshace una edición de categoría aplicada por el asistente usando su operationId.',
      'Úsala cuando el usuario pida deshacer esa edición; no pidas confirmación adicional.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        operationId: { type: 'string', description: 'operationId de la edición aplicada.' },
      },
      required: ['operationId'],
    },
  },
  {
    name: 'apply_category_edits',
    description: [
      'Aplica atómicamente varias operaciones category-only pendientes en una sola transacción DynamoDB.',
      'Úsala para varios previews concretos cuando el total cabe en la transacción; recibe 1–12 operationIds reales y devuelve un recibo por operación.',
      'No mezcles operaciones de tags ni inventes IDs. No pidas confirmación adicional.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        operationIds: { type: 'array', items: { type: 'string' }, description: 'operationIds de previews category-only pendientes.' },
      },
      required: ['operationIds'],
    },
  },
] as const;

export type TagMutationToolName = (typeof TAG_MUTATION_TOOL_DEFINITIONS)[number]['name'];
