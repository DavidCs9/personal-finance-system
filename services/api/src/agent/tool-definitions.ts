export const TOOL_DEFINITIONS = [
  {
    name: 'month_snapshot',
    description:
      'Resumen del mes: Has gastado, Te quedan, proyección, MSI, incertidumbre y monto sin categoría. Usa la misma matemática que Resumen.',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'Mes YYYY-MM' },
      },
      required: ['month'],
    },
  },
  {
    name: 'plan_month_scenario',
    description:
      'Calcula un plan mensual y escenarios de viaje con aritmética determinista usando el gasto real del Resumen. Debes volver a usarla ante cualquier corrección posterior de fecha, tramo, presupuesto, moneda o compromiso; el cálculo anterior queda inválido. Úsala cuando el usuario quiera descubrir cuánto puede gastar: nunca le devuelvas esa pregunta. tripStart y tripEnd son el primer y último día calendario en el destino; tripEnd es inclusivo y nights es la diferencia entre fechas. No infieras la salida de un destino a partir de un vuelo que parte de otra ciudad. Convierte compromisos USD con un tipo de cambio explícito y devuelve cierres de mes. commitments solo debe incluir montos que no estén ya registrados; includeLedgerUpcoming incluye los pagos próximos del Resumen.',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'Mes YYYY-MM.' },
        budgetMxn: { type: 'number', description: 'Tope mensual total en MXN.' },
        commitments: {
          type: 'array',
          description: 'Compromisos adicionales aún no registrados. La moneda es obligatoria; no infieras MXN o USD.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              amount: { type: 'number' },
              currency: { type: 'string', enum: ['MXN', 'USD'] },
            },
            required: ['label', 'amount', 'currency'],
          },
        },
        usdToMxn: { type: 'number', description: 'MXN por USD; obligatorio si hay montos o escenarios USD.' },
        tripStart: { type: 'string', description: 'Primer día del viaje, YYYY-MM-DD.' },
        tripEnd: { type: 'string', description: 'Último día del viaje, YYYY-MM-DD.' },
        dailyUsdScenarios: {
          type: 'array',
          items: { type: 'number' },
          description: 'Escenarios diarios en USD, por ejemplo 100, 150 y 200.',
        },
        includeLedgerUpcoming: {
          type: 'boolean',
          description: 'Default false. Activa solo si los pagos próximos del Resumen deben descontarse además de commitments.',
        },
      },
      required: ['month', 'budgetMxn', 'tripStart', 'tripEnd'],
    },
  },
  {
    name: 'spend_by_category',
    description:
      'Gasto del mes por categoría (cuota MSI del mes, no el ticket completo). Incluye Sin categoría.',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string' },
      },
      required: ['month'],
    },
  },
  {
    name: 'spend_by_merchant',
    description: 'Top comercios del mes; opcionalmente filtrado por categoryId.',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string' },
        categoryId: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['month'],
    },
  },
  {
    name: 'list_movements',
    description:
      'Total y lista de movimientos de gasto para un periodo (máx 50 filas, total sin truncar), opcionalmente filtrados por categoría o tag exacto. Usa range para hoy, ayer, esta semana, últimos 7 días, este mes o este año; custom para fechas explícitas; month para un mes calendario completo. Las fechas usan la zona financiera de México. Si complete=false, aclara que excludedMonthOnlySpentMinor no pudo asignarse al día exacto; no lo sumes al total.',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'Mes calendario YYYY-MM. No combinar con range/fromDay/toDay.' },
        range: {
          type: 'string',
          enum: ['today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'this_year', 'custom'],
          description: 'Default: this_month. Para custom, fromDay y toDay son obligatorios.',
        },
        fromDay: { type: 'string', description: 'Inicio inclusivo YYYY-MM-DD para range=custom.' },
        toDay: { type: 'string', description: 'Fin inclusivo YYYY-MM-DD para range=custom.' },
        categoryId: { type: 'string' },
        tag: { type: 'string', description: 'Tag exacto, por ejemplo viaje:vegas.' },
        limit: { type: 'number', description: 'Máximo de filas devueltas (1–50; default 20).' },
      },
    },
  },
  {
    name: 'compare_months',
    description: 'Compara gasto total y por categoría entre dos meses (default: mes vs anterior).',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string' },
        against: { type: 'string' },
      },
      required: ['month'],
    },
  },
  {
    name: 'wealth_snapshot',
    description: 'Patrimonio neto, activos y deudas de tarjeta (solo lectura).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'investment_history',
    description:
      'Historial general de Bitso o IBKR desde snapshots diarios. Consulta una cuenta o posición por día/rango/all-time; devuelve cambio, serie y cambios por holding. Si cambió la cantidad, trata el resultado como cambio de valor, no rendimiento. accountId puede omitirse si symbol identifica una sola cuenta.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', enum: ['bitso', 'ibkr'] },
        symbol: { type: 'string', description: 'Posición opcional, por ejemplo VOO o SOL' },
        range: {
          type: 'string',
          enum: ['yesterday', 'this_week', 'last_7_days', 'this_month', 'this_year', 'all', 'custom'],
          description: 'Default: this_week. Usa custom con fromDay/toDay para fechas explícitas.',
        },
        fromDay: { type: 'string', description: 'Inicio YYYY-MM-DD para range=custom' },
        toDay: { type: 'string', description: 'Fin YYYY-MM-DD para range=custom' },
        granularity: { type: 'string', enum: ['daily', 'monthly'] },
        limit: { type: 'number', description: 'Máximo de puntos devueltos (1–366; default 120)' },
      },
    },
  },
  {
    name: 'propose_recategorize',
    description:
      'Propone recategorizar un movimiento. No aplica el cambio; la UI debe confirmar.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        categoryId: { type: 'string' },
        merchantRaw: { type: 'string' },
      },
      required: ['eventId', 'categoryId'],
    },
  },
] as const;

export type AgentToolName = (typeof TOOL_DEFINITIONS)[number]['name'];
