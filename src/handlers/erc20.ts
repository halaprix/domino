export async function resolveErc20Token(
  _params: { client: unknown; token: string; owner: string },
): Promise<unknown> {
  void _params;
  throw new Error("Not yet implemented");
}

export async function resolveErc20TokensBulk(
  _params: { client: unknown; tokens: string[]; owner: string },
): Promise<unknown[]> {
  void _params;
  throw new Error("Not yet implemented");
}
