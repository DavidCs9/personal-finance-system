import type { WealthOverview } from "./wealth";

/** Demo seed for local walkthrough — one Cajita snapshot, brokers pending. */
export const demoWealthOverview: WealthOverview = {
  currency: "MXN",
  totalMxnMinor: 8_500_000,
  accounts: [
    {
      id: "nu_cajita_emergencia",
      name: "Cajita Nu",
      institution: "Nu",
      role: "emergency_fund",
      sync: "manual",
      connected: true,
      latestSnapshot: {
        accountId: "nu_cajita_emergencia",
        day: "2026-07-10",
        capturedAt: "2026-07-10T21:00:00.000Z",
        source: "manual",
        currency: "MXN",
        totalMxnMinor: 8_500_000,
        holdings: [
          {
            id: "emergency_fund",
            symbol: "MXN",
            name: "Fondo de emergencia",
            quantity: 85_000,
            currency: "MXN",
            valueNativeMinor: 8_500_000,
            valueMxnMinor: 8_500_000,
          },
        ],
      },
    },
    {
      id: "bitso",
      name: "Bitso",
      institution: "Bitso",
      role: "crypto",
      sync: "api",
      connected: false,
      latestSnapshot: null,
    },
    {
      id: "ibkr",
      name: "IBKR",
      institution: "IBKR",
      role: "brokerage",
      sync: "flex",
      connected: false,
      latestSnapshot: null,
    },
  ],
  history: {
    all: [
      { day: "2026-07-01", totalMxnMinor: 8_000_000 },
      { day: "2026-07-05", totalMxnMinor: 8_250_000 },
      { day: "2026-07-10", totalMxnMinor: 8_500_000 },
    ],
    byAccount: {
      nu_cajita_emergencia: [
        { day: "2026-07-01", totalMxnMinor: 8_000_000 },
        { day: "2026-07-05", totalMxnMinor: 8_250_000 },
        { day: "2026-07-10", totalMxnMinor: 8_500_000 },
      ],
      bitso: [],
      ibkr: [],
    },
  },
};
