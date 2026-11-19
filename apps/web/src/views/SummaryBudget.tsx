import { useEffect, useRef } from "react";
import type { BudgetCategory, BudgetStatus } from "../api/planning-types";
import { Amt } from "../components/Amt";
import { exactMxn, money } from "../lib/format";
import "./summary-budget.css";

const amount = (minor: number) => minor % 100 === 0 ? money(minor) : exactMxn(minor);
const percent = (value: number) => new Intl.NumberFormat("es-MX", { maximumFractionDigits: 1 }).format(value) + "%";
const widthPercent = (minor: number, limit: number) => Math.max(0, Math.min(100, limit > 0 ? minor / limit * 100 : minor > 0 ? 100 : 0));

function BudgetAmount({ minor }: { minor: number }) {
  return <Amt>{amount(minor)}</Amt>;
}

function BudgetHero({ status, privateMode, onOpen }: { status: BudgetStatus; privateMode: boolean; onOpen: () => void }) {
  const limit = status.configured ? status.budget?.totalMxnMinor : undefined;
  if (limit === undefined) return <section className="summary-budget-panel">
    <h2>Presupuesto mensual</h2>
    <p>Sin límite configurado para este mes. Puedes configurarlo en ChatGPT con Olbia.</p>
    <button className="text-button summary-budget-link" type="button" onClick={onOpen}>Ver historial de presupuesto →</button>
  </section>;

  const usage = status.utilizationPercent;
  const withCommitments = status.utilizationWithCommitmentsPercent;
  const remaining = status.remainingMxnMinor!;
  const margin = status.remainingDiscretionaryMxnMinor!;
  const hasCommitments = status.upcomingCommitmentsMxnMinor > 0;
  const active = limit > 0 || remaining < 0 || margin < 0;
  const warning = active ? status.warningWithCommitments : "normal";
  const tone = warning === "100" ? "over" : warning === "90" ? "near" : warning === "70" ? "watch" : "";
  const usedWidth = widthPercent(status.countedSpentMxnMinor, limit);
  const pendingWidth = widthPercent(limit - margin, limit) - usedWidth;
  const usageCopy = warning !== "normal" && withCommitments !== null && hasCommitments ? <><Amt>{percent(withCommitments)}</Amt> con compromisos</> : null;
  return <section className={`summary-budget-panel summary-budget-hero ${tone}${status.warning === "100" && active ? " spent-limit" : ""}`} aria-labelledby="summary-month-budget">
    <div className="summary-budget-top">
      <div>
        <h2 id="summary-month-budget">Presupuesto mensual</h2>
        <strong className="summary-budget-limit"><BudgetAmount minor={limit} /></strong>
      </div>
      <div className="summary-budget-alert">
        <strong>{remaining < 0 ? "Te pasaste del presupuesto" : margin < 0 ? "Los compromisos rebasan el límite"
          : warning === "100" ? "Límite alcanzado" : warning === "90" ? "Cerca del límite"
            : warning === "70" ? "Presupuesto en seguimiento" : hasCommitments ? "Margen tras compromisos" : "Margen del presupuesto"}
          {usageCopy && <> · {usageCopy}</>}</strong>
        <p>{margin < 0 ? <>Faltan <b><BudgetAmount minor={-margin} /></b> para cubrir el gasto{hasCommitments ? " y los compromisos conocidos" : ""}.</>
          : <>Te quedan <b><BudgetAmount minor={margin} /> del presupuesto</b>{hasCommitments ? " tras compromisos conocidos." : "."}</>}</p>
      </div>
    </div>
    {!privateMode && <div className="summary-budget-meter" aria-hidden="true">
      <i style={{ width: `${usedWidth}%` }} /><i style={{ width: `${pendingWidth}%` }} />
    </div>}
    <dl className="summary-budget-facts">
      <div><dt><i aria-hidden="true" />Usado{usage !== null && <> · <Amt>{percent(usage)}</Amt></>}</dt><dd><BudgetAmount minor={status.countedSpentMxnMinor} /></dd></div>
      <div><dt><i aria-hidden="true" />Compromisos</dt><dd><BudgetAmount minor={status.upcomingCommitmentsMxnMinor} /></dd></div>
    </dl>
    <div className="summary-budget-foot">
      {status.incompleteScheduleMovementIds.length > 0 && <p>Hay calendarios MSI incompletos. El margen sólo contempla compromisos conocidos.</p>}
      {status.invalidFixedPaymentLinkIds.length > 0 && <p>Hay vínculos de gastos fijos por revisar.</p>}
      {status.uncertainMxnMinor !== 0 && <p>Incluye <BudgetAmount minor={status.uncertainMxnMinor} /> por confirmar.</p>}
      <button className="text-button summary-budget-link" type="button" onClick={onOpen}>Detalle e historial →</button>
    </div>
  </section>;
}

const tickFormat = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", notation: "compact", maximumFractionDigits: 1 });

function PaceChart({ values, limit, days, month }: {
  values: readonly number[]; limit: number; days: number; month: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const colors = getComputedStyle(canvas);
      const fill = (name: string) => colors.getPropertyValue(name).trim();
      const min = Math.min(0, ...values);
      const max = Math.max(1, limit, ...values);
      const ticks = [min, min / 2 + max / 2, max];
      const labels = ticks.map(tick => tickFormat.format(tick / 100));
      const bottom = height - 23;
      const right = width - 6;
      ctx.font = "11px system-ui, sans-serif";
      const left = Math.max(...labels.map(label => ctx.measureText(label).width)) + 7;
      const x = (day: number) => left + (right - left) * day / days;
      const y = (minor: number) => bottom - (bottom - 10) * (minor - min) / (max - min);

      ctx.lineWidth = 1;
      ctx.textBaseline = "middle";
      ctx.fillStyle = fill("--ink-soft");
      ctx.strokeStyle = fill("--line");
      for (const [index, tick] of ticks.entries()) {
        ctx.beginPath();
        ctx.moveTo(left, y(tick));
        ctx.lineTo(right, y(tick));
        ctx.stroke();
        ctx.fillText(labels[index]!, 0, y(tick));
      }
      ctx.strokeStyle = fill("--amber");
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x(0), y(0));
      ctx.lineTo(x(days), y(limit));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = ctx.fillStyle = fill("--green");
      ctx.lineWidth = 2.5;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(x(0), y(values[0] ?? 0));
      values.slice(1).forEach((value, index) => {
        ctx.lineTo(x(index + 1), y(value));
      });
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x(values.length - 1), y(values.at(-1) ?? 0), 3.5, 0, Math.PI * 2);
      ctx.fill();

      const lastDay = values.length - 1;
      const monthLabel = new Intl.DateTimeFormat("es-MX", { month: "short", timeZone: "UTC" })
        .format(new Date(`${month}-01T12:00:00Z`));
      ctx.fillStyle = fill("--ink-soft");
      ctx.fillText(`1 ${monthLabel}`, left, bottom + 15);
      ctx.textAlign = "right";
      ctx.fillText(`${days} ${monthLabel}`, right, bottom + 15);
      if (lastDay > 5 && lastDay < days - 5) {
        ctx.textAlign = "center";
        ctx.fillText(`${lastDay} ${monthLabel}`, x(lastDay), bottom + 15);
      }
    };
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    draw();
    return () => observer.disconnect();
  }, [values, limit, days, month]);
  return <canvas className="summary-pace-chart" ref={ref} aria-hidden="true" />;
}

function BudgetPace({ status, privateMode }: { status: BudgetStatus; privateMode: boolean }) {
  const limit = status.budget?.totalMxnMinor ?? 0;
  const variance = status.paceVarianceMxnMinor;
  const timeline = status.spendTimeline;
  const active = status.elapsedDays > 0 && status.remainingDays > 0;
  return <section className="summary-budget-panel" aria-labelledby="summary-budget-pace">
    <h2 id="summary-budget-pace">Ritmo de gasto</h2>
    {limit <= 0 ? <p>Se necesita un límite mayor a cero para comparar el ritmo.</p>
      : variance === null ? <p>La comparación empieza cuando comienza el mes.</p> : <>
        <p>{active ? variance === 0 ? "Vas al ritmo del presupuesto." :
          <>Llevas <b><BudgetAmount minor={Math.abs(variance)} /> {variance > 0 ? "por encima" : "por debajo"}</b> del ritmo del presupuesto.</>
          : <>Cierre con <b><BudgetAmount minor={status.countedSpentMxnMinor} /></b> de gasto contado.</>}</p>
        {timeline && timeline.cumulativeMinorByDay.length > 1 && !privateMode && <figure>
          <PaceChart values={timeline.cumulativeMinorByDay} limit={limit} days={status.daysInMonth} month={status.month} />
          <figcaption><span>Gasto acumulado con fecha</span><span>Ritmo del presupuesto</span></figcaption>
        </figure>}
        {timeline && timeline.unplottedEntries > 0 && <p>El total incluye <BudgetAmount minor={timeline.unplottedMinor} /> sin fecha graficable en el periodo.</p>}
      </>}
  </section>;
}

const categorySeverity = (row: BudgetCategory) =>
  row.allocationConfigured && (row.limitMxnMinor ?? 0) > 0 ? row.warning === "100" ? 3 : row.warning === "90" ? 2 : row.warning === "70" ? 1 : 0 : 0;

function BudgetCategories({ status, privateMode, onOpen, onOpenAnalytics }: {
  status: BudgetStatus; privateMode: boolean; onOpen: () => void; onOpenAnalytics: () => void;
}) {
  const configured = status.configured;
  const categories = status.categories.filter(row => row.allocationConfigured || row.grossSpentMxnMinor !== 0)
    .sort((a, b) => categorySeverity(b) - categorySeverity(a) || (configured
      ? b.countedSpentMxnMinor - a.countedSpentMxnMinor : b.grossSpentMxnMinor - a.grossSpentMxnMinor));
  const maxSpend = Math.max(0, ...categories.map(row => row.grossSpentMxnMinor));
  return <section className="summary-budget-panel" aria-labelledby="summary-budget-categories">
    <h2 id="summary-budget-categories">En qué se fue</h2>
    <p>{configured ? "Gasto contado / límite por categoría" : "Gasto registrado por categoría"}</p>
    {categories.length === 0 ? <p>Sin categorías con gasto o asignación este mes.</p> : <ul className="summary-budget-categories">
      {categories.slice(0, 5).map(row => {
        const severity = categorySeverity(row);
        const spent = configured ? row.countedSpentMxnMinor : row.grossSpentMxnMinor;
        const unbudgeted = configured && (row.limitMxnMinor ?? 0) === 0 && spent > 0;
        const tone = unbudgeted || severity === 3 ? "over" : severity === 2 ? "near" : severity === 1 ? "watch" : "";
        const limit = configured ? row.limitMxnMinor ?? 0 : maxSpend;
        return <li key={row.categoryId ?? "uncategorized"} className={tone}>
          <div className="summary-budget-category">
            <strong>{row.label}</strong>
            <span><b><BudgetAmount minor={spent} /></b>{configured && <> / <BudgetAmount minor={limit} /></>}</span>
          </div>
          {!privateMode && <div className="summary-budget-meter" aria-hidden="true"><i style={{ width: `${widthPercent(spent, limit)}%` }} /></div>}
          {unbudgeted ? <p>{row.allocationConfigured ? "Límite en cero" : "Sin asignación"} · <BudgetAmount minor={spent} /> sin cubrir</p> :
            severity > 0 ? <p>{(row.overspentMxnMinor ?? 0) > 0 ? <>Te pasaste <BudgetAmount minor={row.overspentMxnMinor!} /></> :
              row.remainingMxnMinor === 0 ? "Límite alcanzado" : <>Te quedan <BudgetAmount minor={row.remainingMxnMinor!} /></>}
            {row.utilizationPercent !== null && <> · <Amt>{percent(row.utilizationPercent)}</Amt></>}</p> :
            configured && !row.allocationConfigured ? <p>Sin asignación</p> : null}
        </li>;
      })}
    </ul>}
    {configured && status.excludedSpentMxnMinor !== 0 && <p><BudgetAmount minor={status.excludedSpentMxnMinor} /> excluidos del presupuesto.</p>}
    <div className="summary-budget-foot">
      {configured && categories.length > 5 &&
        <button className="text-button summary-budget-link" type="button" onClick={onOpen}>Ver todas las categorías →</button>}
      <button className="text-button summary-budget-link" type="button" onClick={onOpenAnalytics}>Ver análisis y movimientos →</button>
    </div>
  </section>;
}

export function SummaryBudget({ status, privateMode, onOpen, onOpenAnalytics }: {
  status: BudgetStatus; privateMode: boolean; onOpen: () => void; onOpenAnalytics: () => void;
}) {
  return <div className="summary-budget">
    <BudgetHero status={status} privateMode={privateMode} onOpen={onOpen} />
    <div className="summary-budget-charts">
      {status.configured && <BudgetPace status={status} privateMode={privateMode} />}
      <BudgetCategories status={status} privateMode={privateMode} onOpen={onOpen} onOpenAnalytics={onOpenAnalytics} />
    </div>
  </div>;
}
