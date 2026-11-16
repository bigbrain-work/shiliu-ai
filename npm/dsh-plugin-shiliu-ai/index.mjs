import { apply as connectMcp, Config as mcpConfig, inject } from '@deepseek-ai/dsh-mcp-client'

export const name = 'shiliu-ai'
export { inject }

export async function apply(ctx) {
  const apiKey = process.env.SHILIU_DSH_MCP_KEY?.trim()
  if (!apiKey) {
    ctx.logger.warn('Shiliu AI connector needs SHILIU_DSH_MCP_KEY in the DSH launch environment.')
    return
  }

  await connectMcp(ctx, mcpConfig({
    serverName: 'shiliu_ai',
    transport: 'streamable-http',
    url: 'https://api.bigbrain.work/shiliu/mcp',
    headers: { Authorization: 'Bearer ' + apiKey },
  }))
}
