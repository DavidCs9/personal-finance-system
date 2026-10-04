# Reglas financieras de Olbia

Contrato vinculante para API, UI, asistente, analytics y automatizaciones. Sigue el [norte del producto](product-north-star.md). Importes monetarios en enteros seguros de unidades menores; monedas ISO separadas. Instantes en UTC con milisegundos; días y meses financieros en **America/Chihuahua**. No inventar horas para evidencia con precisión de día.

## Observación, evidencia y conciliación

La unidad primaria es el movimiento observado. Correo, Apple Pay, alta manual, CSV y PDF conservan observaciones independientes; vincular fuentes nunca borra ninguna. Guardar originales MIME/CSV/PDF/XML y evidencia manual/provider cifrados con KMS en S3 antes de interpretar; MIME se retiene indefinidamente. Apple Pay conserva campos autenticados y metadata originales en observaciones SQL, sin exigir un archivo S3 ficticio.

La idempotencia identifica cada fuente; no equiparar fecha/comercio/importe con identidad única de una compra. Reintentos devuelven el resultado existente. Conciliar automáticamente sólo una coincidencia única de alta confianza; ambigüedad permanece explícita. No inventar compras, padres, account/card mappings ni historia para satisfacer una relación. Cuenta observada y perfil de ciclo de tarjeta son conceptos distintos.

Importe bancario bruto y parseo original son evidencia inmutable. Correcciones, rechazo, tags, categorías, Mi parte y conciliación crean revisiones auditables sin reescribir fuentes o revisiones previas. Un movimiento rechazado se conserva y no cuenta ni aparece en listas/detalles normales.

Un cobro manual nace accepted y entra al gasto, salvo reglas MSI; un pago próximo es un compromiso, no un cobro observado. Evidencia manual JSON en S3 más observación SQL. Alta manual idempotente por dueño/institución/día/importe/comercio normalizado/últimos cuatro disponibles; una llegada automática posterior se vincula sólo con candidato único compatible. Rechazar corrige su inclusión; edición rica y adjuntos manuales no forman parte del flujo actual.

Apple Pay Santander doméstico se vincula con correo sólo con candidato único de misma institución/tipo/moneda/importe/comercio normalizado y hasta 30 minutos de diferencia. Repeticiones de esa fuente dentro de dos minutos con comercio/importe iguales tienen protección defensiva de retry. Una autorización USD queda pending_foreign, fuera de gasto MXN. El correo Santander puede promover el mismo movimiento al bruto posteado MXN, preservando la observación USD, con fecha cercana/comercio compatible y sin múltiples candidatos. No estimar FX para el gasto.

## Resumen del mes

**Has gastado** incluye compras normales accepted y needs_review, usando **Mi parte** cuando exista, más cuotas MSI spent del mes. Excluye rejected, pending_foreign y deferred_msi. Needs_review sigue dentro, con importe incierto visible.

**Mi parte** es opcional sólo para compras no-MSI, entre cero y bruto bancario. Cero difiere de ausencia. UI, resumen, categorías, proyección, asistente y push usan Mi parte; conciliación bancaria siempre usa bruto. No añadir participantes, deudas compartidas o liquidaciones.

**Te quedan** usa liquidez menos gasto realizado, pagos próximos y cuotas committed pendientes. Nunca restar una cuota como spent y committed a la vez. La proyección aplica ritmo sólo a gasto discrecional no-MSI y añade MSI gastado y compromisos pendientes. Sin liquidez válida, disponibilidad/proyección no son válidas.

Categorías son excluyentes y suman Has gastado; NULL significa **Sin categoría** y debe declararse. El catálogo SQL es la autoridad, sin overlay permanente de defaults. Asignación/apply/undo valida membresía; ausencia de regla se conserva como NULL SQL/contrato público correspondiente. Reglas por comercio mantienen precedencia exacta/patrón más largo/empate existente. Una edición individual puede actualizar regla cuando se confirma; el asistente nunca lo hace.

Tags son contextos superpuestos: no cambian gasto, MSI, conciliación ni patrimonio. Sus totales no se suman como partes exclusivas. Máximo 20 tags normalizados por movimiento, 48 caracteres, minúsculas, formato nombre o namespace:valor, sin duplicados/vacíos.

Analytics compara el mes actual con los mismos días calendario transcurridos del anterior; meses terminados pueden compararse completos. Si una cuota histórica sólo tiene precisión mensual, excluirla de comparación por días y declarar su importe, sin inventar fecha. Mantener visibles importes sin categoría y por confirmar, con acceso a evidencia.

## MSI y estados de cuenta

Un plan corresponde a una compra/comercio con principal, cuota y fin; no es servicio indefinido. Sólo la cuota del mes cuenta. Cuotas committed pasan a spent cuando evidencia confirma; canceladas permanecen en historia. Liquidación anticipada es manual: cancelar restantes y registrar cargo de cierre si aplica.

El calendario inicia en 1/N. Si el estado trae 3/12, retroceder al inicio, marcar 1–2 gastadas, confirmar 3 con evidencia y dejar futuras pendientes; anclar compra al mes de primera cuota. No abrir un plan nuevo para cada cuota de uno existente.

PDF Amex/Santander es el camino preferido para abrir planes con i/N y total disponible. Santander usa su tabla de planes. Una cuota sin plan/i/N queda needs_decision; el usuario crea plan, confirma existente u omite. Si ya trae i/N completo, omitir crea el plan con esa metadata, incluidas etiquetas **MESES EN AUTOMÁTICO**. Sin i/N, omitir no incorpora el gasto. CSV confirma planes existentes; no inferir un schedule sin metadata suficiente.

Correo o alta manual Amex de importe **mayor a $2,500.00** abre amex_auto de tres meses, modificable por David. Compras Amex Gold cubiertas por **MONTO A DIFERIR MESES EN AUTOMÁTICO** quedan deferred_msi: visibles, fuera de Has gastado; sólo la cuota auto cuenta.

CSV Santander identifica por tarjeta/consecutivo; sin consecutivo usa día/concepto normalizado/importe/ordinal dentro del extracto y exige decisión explícita en primera importación. Pagos/abonos negativos quedan fuera del gasto. Coincidencia única enlaza evidencia; varios candidatos requieren decisión. PDF preview/poll/apply usa extracción Textract QUERIES/TABLES retenida en S3. Apply reconstruye esa evidencia y confirma todo el lote financiero y el resultado del import en una transacción; un fallo o presupuesto excedido revierte todo.

Identidades de fila repetidas entre archivos no son globalmente únicas. Proveniencia MSI conserva fila probada, candidatos ambiguos o referencia legacy según evidencia. Claims suprimidos o con destino histórico ausente no se borran ni se convierten en relaciones fabricadas. Igual firma de comparación no prueba captura duplicada; limpieza financiera requiere nueva evidencia o decisión explícita y mutación auditada.

## Nómina y gastos fijos

Ingreso del mes deriva de CFDI nómina XML: neto Total por FechaPago. UUID único; importación duplicada no cambia fecha, valores, evidencia ni líneas. Conservar totales fuente y líneas SAT en orden, incluidas repetidas/cero. Estimados, liquidez, compensación y Fondo son derivados, no saldos autoritativos paralelos.

Con una nómina ordinaria en el mes actual, estimar segunda quincena; retirar estimado al llegar segunda ordinaria o cerrar mes. Sin nóminas actuales, liquidez provisional usa últimas 1–2 ordinarias: doble de última o suma de dos recientes. Al subir primera del mes, aplicar lógica normal. Mes pasado sin nóminas queda sin configurar.

Compensación = liquidez + aportaciones Fondo SAT 004, con fondo gemelo cuando aplica estimado de segunda quincena. Resumen y porcentaje gastado usan liquidez, nunca compensación.

GET /months/{month} deriva nómina/liquidez y resuelve gastos fijos. PUT sólo guarda upcomingPayments. Mes sin configuración propia hereda lista completa del último anterior: lectura sin escritura. Primer alta/cambio/borrado materializa la lista completa del mes elegido; lista vacía explícita detiene herencia. No eliminar padres vacíos ni modificar meses previos. Reemplazo preserva IDs/orden y es atómico. Días 29–31 se ajustan al último día si el mes es corto. Gastos fijos, MSI y ciclos de tarjeta permanecen separados.

## Patrimonio

**Neto = activos − saldos pendientes de tarjeta**, en MXN; separado de gasto/Te quedan. Activos: Cajita Nu, Fondo de ahorro, Bitso e Interactive Brokers. Holdings conservan moneda/valores/cantidades nativos y evidencia de FX; total de captura de activos deriva de holdings SQL.

Cajita captura saldo manual positivo. Hasta tres perfiles activos permiten capturar manualmente deuda total de tarjeta, incluido MSI; cero es válido para pagada. Perfiles contienen corte/pago, no montos mensuales. Borrado desactiva perfil, oculta sus ciclos/pasivos del producto y conserva identidad/capturas; reactivar mismo ID respeta límite activo y comportamiento existente.

Capturas y holdings son inmutables, sin TTL financiero. Selección canónica por cuenta o tarjeta/día Chihuahua: reemplazo cambia puntero y conserva ambas capturas con relación de sucesión, incluso si medición tiene hora igual/anterior. Cajita y cada deuda se marcan antiguas tras siete días.

Bitso sincroniza balances y tickers MXN. IBKR usa Flex Query, posiciones/cash USD y Banxico FIX SF43718; posiciones no-USD se omiten según contrato actual. Conservar cantidades/cash con signo y precisión provider. Fallo mantiene última captura buena y expone error; alerta por push/email. Sync manual y programado usan misma operación.

Fondo deriva de deducciones SAT 004 del año calendario, empleado y empleador. Cuenta completo como activo ilíquido hasta diciembre; no inventar reset de liquidación sin XML que pruebe esa operación.

Patrimonio actual no cambia de significado al elegir otro mes. Historial total: cierres mensuales de Neto desde **2026-08**, omitiendo prehistoria incompleta. Historial por cuenta: diario. Carry-forward usa última captura disponible en o antes de fecha de corte. El asistente distingue inversiones de mercado Bitso+IBKR de Neto: ese scope excluye Cajita, Fondo y tarjetas. Variación observada MXN incluye FX y no es rendimiento ajustado por flujos/costo base/dividendos.

## Cierre mensual

Reportar mes calendario completo anterior. Gasto conserva exactamente Has gastado; categorías comparan mes anterior completo y promedio de tres anteriores, tags siguen superpuestos. Patrimonio se resuelve al último día del mes reportado, con Fondo por FechaPago hasta ese día. Capturas del día 1 no contaminan cierre anterior; primera comparación total completa desde agosto 2026.

IA recibe MonthlyCloseFacts determinista y devuelve JSON Schema sin dígitos, monedas ni porcentajes; el renderer inserta cifras desde esos facts. No usa memoria del chat, tools de mutación ni búsqueda web. Puede seleccionar/explicar hechos, nunca calcular/inventar cifras, modificar movimientos o atribuir causalidad entre gasto y cambio patrimonial. Cifras/deltas/frescura provienen de código y datos persistidos; si IA falla, enviar reporte numérico con lectura determinista. [Operación](operations.md) define schedules y reintentos.
