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
 *
 * Tools are registered **dynamically** after connecting to each MCP server.
 * Every tool name is prefixed with the server name so that identically-named
 * tools on different servers never collide.
 *
 * Example: servers "payments" and "users" both expose "ask"
 *   → registered as "payments_ask" and "users_ask"
 */
export default function register(api) {
  const mcpManager = new MCPManager(api.logger);

  /**
   * Dynamically register every tool discovered on a server.
   * Tool names are prefixed: `<serverName>_<toolName>`
   */
  function registerServerTools(serverName, tools) {
    for (const tool of tools) {
      const prefixedName = `${serverName}_${tool.name}`;

      // Build the parameter schema from the remote tool's inputSchema
      const inputSchema = tool.inputSchema || { type: 'object', properties: {} };

      api.registerTool({
        name: prefixedName,
        description: `[${serverName}] ${tool.description || tool.name}`,
        parameters: inputSchema,
        async execute(_id, params) {
          try {
            const result = await mcpManager.callTool(serverName, tool.name, params);
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

      api.logger.info(`[MCP] Registered tool: ${prefixedName}`);
    }
  }

  api.registerService({
    id: 'mcp-integration',
    start: async () => {
      api.logger.info('[MCP] Starting...');

      const pluginConfig = api.config?.plugins?.entries?.['mcp-integration']?.config || {};
      const servers = pluginConfig.servers || {};

      let totalTools = 0;

      for (const [name, config] of Object.entries(servers)) {
        if (config.enabled !== false && config.url) {
          try {
            const tools = await mcpManager.connectServer(name, config);
            registerServerTools(name, tools);
            totalTools += tools.length;
          } catch (error) {
            api.logger.error(`[MCP] Failed to initialize ${name}: ${error.message}`);
          }
        }
      }

      api.logger.info(
        `[MCP] Started – ${Object.keys(servers).length} server(s) configured, ${totalTools} tool(s) registered`
      );
    },
    stop: async () => {
      api.logger.info('[MCP] Stopping...');
      await mcpManager.disconnect();
    }
  });

  // Utility: list all available tools across every connected server
  api.registerTool({
    name: 'mcp_list_tools',
    description: 'List all available MCP tools across every connected server, including their server-prefixed names.',
    parameters: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description: 'Optional – restrict listing to a single server by name.'
        }
      }
    },
    async execute(_id, params) {
      try {
        let tools = mcpManager.listTools();
        if (params.server) {
          tools = tools.filter(t => t.server === params.server);
        }
        // Add the prefixed name so callers know what to invoke
        tools = tools.map(t => ({
          ...t,
          registeredAs: `${t.server}_${t.name}`
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(tools, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  });

  // Utility: call any tool on any server (fallback / escape hatch)
  api.registerTool({
    name: 'mcp_call',
    description: 'Call any tool on any connected MCP server by specifying the server name, tool name, and arguments. Use this as an escape hatch when you know the exact server and tool names.',
    parameters: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description: 'Name of the MCP server (as defined in configuration).'
        },
        tool: {
          type: 'string',
          description: 'Name of the tool to invoke on that server.'
        },
        args: {
          type: 'object',
          description: 'Arguments to pass to the tool (schema depends on the tool).'
        }
      },
      required: ['server', 'tool']
    },
    async execute(_id, params) {
      try {
        const result = await mcpManager.callTool(params.server, params.tool, params.args || {});
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
