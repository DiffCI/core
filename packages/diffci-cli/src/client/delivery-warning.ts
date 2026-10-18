export function githubDeliveryWarning(delivery: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!delivery.startsWith("not sent") || env.GITHUB_ACTIONS !== "true") return undefined;
  const escaped = delivery.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  return `::warning title=DiffCI report delivery failed::${escaped}`;
}
