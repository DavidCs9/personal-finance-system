import { TabButton } from "../components/TabButton";
import type { Tab } from "../lib/tabs";

export function TabNav({
  tab,
  onTabChange,
  variant,
}: {
  tab: Tab;
  onTabChange(tab: Tab): void;
  variant: "desktop" | "mobile";
}) {
  const className = variant === "desktop" ? "desktop-tabs" : "mobile-tabs";
  const label = variant === "desktop" ? "Secciones" : "Navegación principal";
  const Element = variant === "desktop" ? "div" : "nav";

  return (
    <Element className={className} role="tablist" aria-label={label}>
      <TabButton active={tab === "summary"} onClick={() => onTabChange("summary")} icon="summary">
        Resumen
      </TabButton>
      <TabButton
        active={tab === "movements"}
        onClick={() => onTabChange("movements")}
        icon="movements"
      >
        Movimientos
      </TabButton>
      <TabButton active={tab === "wealth"} onClick={() => onTabChange("wealth")} icon="wealth">
        Patrimonio
      </TabButton>
    </Element>
  );
}
