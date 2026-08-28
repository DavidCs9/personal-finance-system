export const TAG_MUTATION_TOOL_DEFINITIONS = [
  {
    name: 'preview_tag_edit',
    description: [
      'Congela los movimientos accepted de un rango inclusivo antes de cambiar tags.',
      'Cuando el usuario pida explícitamente agregar o quitar tags, usa esta tool directamente; no llames list_movements primero.',
      'La instrucción del usuario en el chat autoriza el cambio: después de recibir operationId debes llamar apply_tag_edit inmediatamente en el mismo turno, sin pedir confirmación en la UI.',
      'Sólo modifica tags; nunca categorías.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        fromDay: { type: 'string', description: 'Inicio inclusivo YYYY-MM-DD.' },
        toDay: { type: 'string', description: 'Fin inclusivo YYYY-MM-DD.' },
        addTags: { type: 'array', items: { type: 'string' }, description: 'Tags que se agregarán.' },
        removeTags: { type: 'array', items: { type: 'string' }, description: 'Tags que se quitarán.' },
      },
      required: ['fromDay', 'toDay'],
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
    name: 'preview_category_edit',
    description: [
      'Congela los movimientos accepted de un rango inclusivo antes de cambiar su categoría.',
      'Cuando el usuario pida explícitamente cambiar una categoría por rango, usa esta tool directamente; no llames list_movements primero.',
      'La instrucción del usuario en el chat autoriza el cambio: después de recibir operationId debes llamar apply_category_edit inmediatamente en el mismo turno, sin pedir confirmación en la UI.',
      'Sólo modifica categoryId; nunca tags ni reglas de comercio.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        fromDay: { type: 'string', description: 'Inicio inclusivo YYYY-MM-DD.' },
        toDay: { type: 'string', description: 'Fin inclusivo YYYY-MM-DD.' },
        categoryId: { type: 'string', description: 'ID de categoría destino del catálogo de Olbia.' },
      },
      required: ['fromDay', 'toDay', 'categoryId'],
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
] as const;

export type TagMutationToolName = (typeof TAG_MUTATION_TOOL_DEFINITIONS)[number]['name'];
