/** Shared SQL resolution for planning, budget and future commitments. The caller supplies requested(month). */
export const effectiveFixedExpenses = (owner: string) => `
effective_plans AS (
  SELECT r.month, MAX(p.month) AS source_month FROM requested r
  LEFT JOIN olbia.month_plans p ON p.owner=${owner} AND p.month<=r.month AND p.occurrence_only IS NOT TRUE
  GROUP BY r.month
), current_fixed_versions AS (
  SELECT DISTINCT ON (e.month,v.payment_id,v.scope) e.month,v.payment_id,v.scope,v.status,
    v.name,v.amount_mxn_minor,v.due_day,v.operation_id,v.effective_month
  FROM effective_plans e JOIN olbia.fixed_expense_versions v ON v.owner=${owner}
    AND ((v.scope='recurring' AND v.effective_month<=e.month) OR (v.scope='month' AND v.effective_month=e.month))
  ORDER BY e.month,v.payment_id,v.scope,v.effective_month DESC,v.revision DESC
), fixed_candidates AS (
  SELECT e.month,p.id,p.name,p.amount_mxn_minor,p.due_day,p.sort_order,
    'active' AS status,'legacy' AS source,e.source_month AS effective_month,NULL::uuid AS operation_id,1 AS priority
  FROM effective_plans e JOIN olbia.planned_payments p ON p.month=e.source_month AND p.occurrence_only IS NOT TRUE
  UNION ALL
  SELECT month,payment_id,name,amount_mxn_minor,due_day,100,status,scope,effective_month,operation_id,
    CASE WHEN scope='month' THEN 3 ELSE 2 END
  FROM current_fixed_versions WHERE status<>'inherit'
  UNION ALL
  SELECT r.month,p.id,COALESCE(c.scheduled_name,p.name),COALESCE(c.scheduled_amount_minor,p.amount_mxn_minor),
    COALESCE(c.scheduled_due_day,p.due_day),COALESCE(base.sort_order,100),'active','linked',r.month,NULL::uuid,4
  FROM requested r JOIN olbia.month_plans plan ON plan.month=r.month AND plan.owner=${owner}
  JOIN olbia.planned_payment_charges c ON c.month=r.month
  JOIN olbia.planned_payments p ON p.month=c.month AND p.id=c.payment_id
  JOIN effective_plans e ON e.month=r.month
  LEFT JOIN olbia.planned_payments base ON base.month=e.source_month AND base.id=p.id AND base.occurrence_only IS NOT TRUE
), fixed_configurations AS (
  SELECT DISTINCT ON (month,id) * FROM fixed_candidates WHERE source IN ('legacy','recurring')
  ORDER BY month,id,priority DESC
), effective_fixed AS (
  SELECT DISTINCT ON (month,id) * FROM fixed_candidates ORDER BY month,id,priority DESC
), fixed_plan_metadata AS (
  SELECT e.month, CASE WHEN MAX(c.priority)>1 THEN e.month ELSE e.source_month END AS source_month,
    GREATEST(base.updated_at, MAX(operation.created_at), MAX(linked_plan.updated_at)) AS updated_at
  FROM effective_plans e LEFT JOIN olbia.month_plans base ON base.month=e.source_month
  LEFT JOIN fixed_candidates c ON c.month=e.month
  LEFT JOIN olbia.financial_write_operations operation ON operation.operation_id=c.operation_id
  LEFT JOIN olbia.month_plans linked_plan ON linked_plan.month=e.month AND c.source='linked'
  GROUP BY e.month,e.source_month,base.updated_at
)`;
