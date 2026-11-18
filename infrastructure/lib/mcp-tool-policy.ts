/** Shared policy builder for every bounded write target. Scope delimiters are exact Cognito token boundaries. */
export const mcpToolPolicy = (input: { owner: string; gatewayArn: string; targetName: string; toolNames: readonly string[]; scope: string }): string => {
  const quote = (value: string) => JSON.stringify(value);
  const scope = input.scope;
  return `permit(
  principal == AgentCore::OAuthUser::${quote(input.owner)},
  action in [${input.toolNames.map(name => `AgentCore::Action::${quote(`${input.targetName}___${name}`)}`).join(',')}],
  resource == AgentCore::Gateway::${quote(input.gatewayArn)}
) when {
  principal.hasTag("token_use") && principal.getTag("token_use") == "access" &&
  principal.hasTag("scope") && (
    principal.getTag("scope") == ${quote(scope)} ||
    principal.getTag("scope") like ${quote(`${scope} *`)} ||
    principal.getTag("scope") like ${quote(`* ${scope}`)} ||
    principal.getTag("scope") like ${quote(`* ${scope} *`)}
  )
};`;
};
