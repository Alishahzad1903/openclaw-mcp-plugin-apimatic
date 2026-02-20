import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from './http-transport.js';

/**
 * MCP Integration Plugin for OpenClaw
 * Connects to MCP servers via Streamable HTTP transport
 */
class MCPManager {
  constructor(logger) {
    this.logger = logger;
    this.clients = new Map();
    this.tools = new Map();
  }

  async connectServer(name, config) {
    try {
      const url = config.url;
      let safeUrl = url;
      try {
        const u = new URL(url);
        u.password = '';
        u.username = '';
        safeUrl = u.toString();
      } catch (e) {
        // invalid url, just keep it as is or mask it
      }
      this.logger.info(`[MCP] Connecting to ${name} at ${safeUrl}`);

      const transport = new StreamableHTTPClientTransport(url);

      const client = new Client(
        { name: `openclaw-${name}`, version: '0.1.0' },
        { capabilities: {} }
      );

      await client.connect(transport);

      const { tools } = await client.listTools();

      this.clients.set(name, { client, transport });

      tools.forEach(tool => {
        this.tools.set(`${name}:${tool.name}`, {
          server: name,
          tool,
          client
        });
      });

      this.logger.info(`[MCP] Connected to ${name}: ${tools.length} tools available`);
      return tools;
    } catch (error) {
      this.logger.error(`[MCP] Failed to connect to ${name}: ${error.message}`);
      throw error;
    }
  }

  async callTool(serverName, toolName, args = {}) {
    const toolKey = `${serverName}:${toolName}`;
    const entry = this.tools.get(toolKey);

    if (!entry) {
      throw new Error(`Tool not found: ${toolKey}. Available: ${Array.from(this.tools.keys()).join(', ')}`);
    }

    const result = await entry.client.callTool({ name: toolName, arguments: args });
    return result;
  }

  listTools() {
    const toolList = [];
    for (const [key, entry] of this.tools.entries()) {
      toolList.push({
        id: key,
        server: entry.server,
        name: entry.tool.name,
        description: entry.tool.description,
        inputSchema: entry.tool.inputSchema
      });
    }
    return toolList;
  }

  async disconnect() {
    for (const [name, { client }] of this.clients.entries()) {
      try {
        await client.close();
        this.logger.info(`[MCP] Disconnected from ${name}`);
      } catch (error) {
        this.logger.error(`[MCP] Error disconnecting from ${name}: ${error.message}`);
      }
    }
    this.clients.clear();
    this.tools.clear();
  }
}

/**
 * OpenClaw plugin entry point
 */
export default function register(api) {
  const mcpManager = new MCPManager(api.logger);

  let serverName = null;

  api.registerService({
    id: 'mcp-integration',
    start: async () => {
      api.logger.info('[MCP] Starting...');

      const pluginConfig = api.config?.plugins?.entries?.['mcp-integration']?.config || {};
      const servers = pluginConfig.servers || {};

      for (const [name, config] of Object.entries(servers)) {
        if (config.enabled !== false && config.url) {
          try {
            await mcpManager.connectServer(name, config);
            serverName = name;
          } catch (error) {
            api.logger.error(`[MCP] Failed to initialize ${name}: ${error.message}`);
          }
        }
      }

      api.logger.info('[MCP] Started');
    },
    stop: async () => {
      api.logger.info('[MCP] Stopping...');
      await mcpManager.disconnect();
    }
  });

  api.registerTool({
    name: 'ask',
    description: 'Chat with API Copilot. Use API Copilot as the expert on API integration with code. Break down the user\'s query into steps and ask API Copilot about each step.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Break down the user\'s query into steps and use this tool to obtain precise integration steps and integration code samples (e.g., "What steps should I follow to update delivery address for a card?", "How can I move a user from one group to another?")'
        }
      },
      required: ['prompt']
    },
    async execute(_id, params) {
      try {
        const result = await mcpManager.callTool(serverName, 'ask', params);
        return {
          content: result.content || [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  });

  api.registerTool({
    name: 'model_search',
    description: 'Search and return an SDK model\'s definition and its properties. Invoke this tool whenever you need to use an SDK request/response model or any of its properties. This tool does not call APIs or generate code; it only provides SDK model definitions.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Exact or partial SDK model name to search, case-sensitive (e.g., `availableBalance`, `user_profile`, `TransactionId`)'
        }
      },
      required: ['query']
    },
    async execute(_id, params) {
      try {
        const result = await mcpManager.callTool(serverName, 'model_search', params);
        return {
          content: result.content || [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  });

  api.registerTool({
    name: 'endpoint_search',
    description: 'Search for and return an SDK endpoint method\'s description, parameters, and response. Invoke this tool whenever you need information about an SDK endpoint method. This tool does not call APIs or generate code; it only provides the endpoint method\'s description, parameters, and response.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Exact or partial SDK endpoint method name to search, case-sensitive (e.g., `createUser`, `get_account_balance`, `UpdateTransaction`)'
        }
      },
      required: ['query']
    },
    async execute(_id, params) {
      try {
        const result = await mcpManager.callTool(serverName, 'endpoint_search', params);
        return {
          content: result.content || [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  });

  api.logger.info('[MCP] Plugin registered');
}
