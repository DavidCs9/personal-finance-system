/** Expected domain rejections are tool data, not Gateway/Lambda failures. */
export const rejectedToolRequest = (message: string, recoveryTool: string) => ({
  ok: false as const,
  status: 'invalid_request' as const,
  message,
  retryable: false,
  recovery: { tool: recoveryTool, action: 'Vuelve a consultar y corrige los argumentos; no repitas la misma solicitud.' },
});

export const isRejectedToolRequest = (payload: Record<string, unknown> | undefined): boolean =>
  payload?.ok === false && payload.status === 'invalid_request';
