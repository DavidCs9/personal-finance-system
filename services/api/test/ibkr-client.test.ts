import { describe, expect, it, vi } from 'vitest';
import {
  buildIbkrHoldings,
  fetchBanxicoUsdMxnFix,
  isIbkrFlexCredentialsConfigured,
  parseFlexCashBalances,
  parseFlexOpenPositions,
  sendFlexRequest,
} from '../src/wealth/ibkr-client.js';

const sampleFlexXml = `
<?xml version="1.0"?>
<FlexQueryResponse queryName="Wealth" type="AF">
  <FlexStatements>
    <FlexStatement accountId="U123" fromDate="20260701" toDate="20260710">
      <OpenPositions>
        <OpenPosition accountId="U123" currency="USD" assetCategory="STK" symbol="VOO"
          description="VANGUARD S&P 500 ETF" conid="3000" position="12.5" markPrice="500"
          positionValue="6250" />
        <OpenPosition accountId="U123" currency="EUR" assetCategory="STK" symbol="VWCE"
          description="VANGUARD FTSE" position="3" positionValue="300" />
      </OpenPositions>
      <CashReport>
        <CashReportCurrency accountId="U123" currency="USD" endingCash="1500.25" />
        <CashReportCurrency accountId="U123" currency="BASE" endingCash="1500.25" />
      </CashReport>
    </FlexStatement>
  </FlexStatements>
</FlexQueryResponse>
`;

describe('isIbkrFlexCredentialsConfigured', () => {
  it('rejects pending placeholders', () => {
    expect(isIbkrFlexCredentialsConfigured({
      flexToken: 'pending',
      flexQueryId: 'pending',
    })).toBe(false);
  });

  it('accepts real credentials', () => {
    expect(isIbkrFlexCredentialsConfigured({
      flexToken: 'token',
      flexQueryId: '123456',
    })).toBe(true);
  });
});

describe('parseFlexOpenPositions', () => {
  it('parses USD positions and keeps non-USD for caller filtering', () => {
    expect(parseFlexOpenPositions(sampleFlexXml)).toEqual([
      {
        symbol: 'VOO',
        name: 'VANGUARD S&P 500 ETF',
        quantity: 12.5,
        currency: 'USD',
        positionValue: 6250,
        assetCategory: 'STK',
        conid: '3000',
      },
      {
        symbol: 'VWCE',
        name: 'VANGUARD FTSE',
        quantity: 3,
        currency: 'EUR',
        positionValue: 300,
        assetCategory: 'STK',
      },
    ]);
  });
});

describe('parseFlexCashBalances', () => {
  it('parses currency cash and skips BASE', () => {
    expect(parseFlexCashBalances(sampleFlexXml)).toEqual([
      { currency: 'USD', endingCash: 1500.25 },
    ]);
  });
});

describe('buildIbkrHoldings', () => {
  it('values USD rows with Banxico FIX and skips other currencies', () => {
    const positions = parseFlexOpenPositions(sampleFlexXml);
    const cash = parseFlexCashBalances(sampleFlexXml);
    const result = buildIbkrHoldings(positions, cash, 20);
    expect(result.skipped).toEqual(['VWCE:EUR']);
    expect(result.holdings).toEqual([
      {
        id: 'ibkr:3000',
        symbol: 'VOO',
        name: 'VANGUARD S&P 500 ETF',
        quantity: 12.5,
        currency: 'USD',
        valueNativeMinor: 625_000,
        valueMxnMinor: 12_500_000,
      },
      {
        id: 'ibkr:cash:USD',
        symbol: 'USD',
        name: 'Efectivo USD',
        quantity: 1500.25,
        currency: 'USD',
        valueNativeMinor: 150_025,
        valueMxnMinor: 3_000_500,
      },
    ]);
  });
});

describe('sendFlexRequest', () => {
  it('reads ReferenceCode from SendRequest XML', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      '<FlexStatementResponse><Status>Success</Status><ReferenceCode>998877</ReferenceCode></FlexStatementResponse>',
      { status: 200 },
    ));
    await expect(sendFlexRequest({ flexToken: 't', flexQueryId: '1' }, fetchImpl)).resolves.toEqual({
      referenceCode: '998877',
    });
  });
});

describe('fetchBanxicoUsdMxnFix', () => {
  it('reads oportuno FIX rate', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      bmx: {
        series: [{
          idSerie: 'SF43718',
          datos: [{ fecha: '05/08/2026', dato: '18.4523' }],
        }],
      },
    }), { status: 200 }));
    await expect(fetchBanxicoUsdMxnFix('token', fetchImpl)).resolves.toEqual({
      rate: 18.4523,
      fecha: '05/08/2026',
    });
  });
});
