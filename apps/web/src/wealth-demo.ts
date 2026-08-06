import type { WealthOverview } from "./wealth";

/** Demo seed for local walkthrough — Cajita + Bitso connected; IBKR pending. */
export const demoWealthOverview: WealthOverview = {
  currency: "MXN",
  totalMxnMinor: 9_750_000,
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
      connected: true,
      latestSnapshot: {
        accountId: "bitso",
        day: "2026-07-10",
        capturedAt: "2026-07-10T12:30:00.000Z",
        source: "api",
        currency: "MXN",
        totalMxnMinor: 1_250_000,
        fxSource: "bitso_ticker",
        holdings: [
          {
            id: "bitso:btc",
            symbol: "BTC",
            name: "BTC",
            quantity: 0.01,
            currency: "BTC",
            valueNativeMinor: 1_000_000,
            valueMxnMinor: 1_000_000,
          },
          {
            id: "bitso:mxn",
            symbol: "MXN",
            name: "Efectivo MXN",
            quantity: 2_500,
            currency: "MXN",
            valueNativeMinor: 250_000,
            valueMxnMinor: 250_000,
          },
        ],
      },
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
      { day: "2026-07-01", totalMxnMinor: 9_000_000 },
      { day: "2026-07-05", totalMxnMinor: 9_400_000 },
      { day: "2026-07-10", totalMxnMinor: 9_750_000 },
    ],
    byAccount: {
      nu_cajita_emergencia: [
        { day: "2026-07-01", totalMxnMinor: 8_000_000 },
        { day: "2026-07-05", totalMxnMinor: 8_250_000 },
        { day: "2026-07-10", totalMxnMinor: 8_500_000 },
      ],
      bitso: [
        { day: "2026-07-01", totalMxnMinor: 1_000_000 },
        { day: "2026-07-05", totalMxnMinor: 1_150_000 },
        { day: "2026-07-10", totalMxnMinor: 1_250_000 },
      ],
      ibkr: [],
    },
  },
};
