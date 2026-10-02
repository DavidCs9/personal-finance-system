import { describe, expect, it, vi } from 'vitest';
import { StartDocumentAnalysisCommand, GetDocumentAnalysisCommand, type TextractClient } from '@aws-sdk/client-textract';
import { startTextractDocumentAnalysis, getTextractAnalysisJobStatus, TextractDocumentError } from '../src/imports/textract-document.js';

describe('native Textract lifecycle capabilities',()=>{
  it('uses stable native start tokens for one attempt and changes them for explicit retries or evidence/provider changes',async()=>{
    const send=vi.fn(async(_command:StartDocumentAnalysisCommand)=>({JobId:'native-job'}));const client={send} as unknown as TextractClient;
    for(const prior of [undefined,undefined,'failed-job'])expect(await startTextractDocumentAnalysis(client,'evidence','original.pdf','amex',prior)).toBe('native-job');
    await startTextractDocumentAnalysis(client,'evidence','different.pdf','amex');
    await startTextractDocumentAnalysis(client,'evidence','original.pdf','santander');
    const commands=send.mock.calls.map(c=>c[0] as unknown as StartDocumentAnalysisCommand);
    expect(commands.every(c=>c instanceof StartDocumentAnalysisCommand)).toBe(true);
    const tokens=commands.map(c=>c.input.ClientRequestToken);
    expect(tokens[0]).toMatch(/^[a-f0-9]{64}$/);expect(tokens[0]).toBe(tokens[1]);
    expect(new Set(tokens)).toHaveProperty('size',4);
    expect(commands[0]?.input).toMatchObject({FeatureTypes:['TABLES','QUERIES'],DocumentLocation:{S3Object:{Bucket:'evidence',Name:'original.pdf'}}});
  });
  it('distinguishes expired job IDs from transient provider failure and preserves actual terminal status',async()=>{
    const send=vi.fn(async(_command:GetDocumentAnalysisCommand)=>({JobStatus:'SUCCEEDED',StatusMessage:'Complete'}));const client={send} as unknown as TextractClient;
    expect(await getTextractAnalysisJobStatus(client,'original-job')).toEqual({status:'SUCCEEDED',statusMessage:'Complete'});
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetDocumentAnalysisCommand);
    send.mockRejectedValueOnce(Object.assign(new Error('Expired'),{name:'InvalidJobIdException'}));
    await expect(getTextractAnalysisJobStatus(client,'expired-job')).rejects.toBeInstanceOf(TextractDocumentError);
    send.mockRejectedValueOnce(Object.assign(new Error('Provider unavailable'),{name:'ThrottlingException'}));
    await expect(getTextractAnalysisJobStatus(client,'original-job')).rejects.toThrow('Provider unavailable');
  });
});
