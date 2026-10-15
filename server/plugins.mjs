import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { modelAllowedTools } from './policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function loadPlugins(file = resolve(ROOT, 'plugins.json')) {
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(parsed.plugins)) throw new Error('plugins.json must contain a plugins array.');
  const names = new Set();
  for (const plugin of parsed.plugins) {
    if (!plugin || typeof plugin.name !== 'string' || !plugin.name.trim()) throw new Error('Every plugin needs a name.');
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(plugin.name)) throw new Error(`Plugin name is invalid: ${plugin.name}`);
    if (names.has(plugin.name)) throw new Error(`Duplicate plugin name: ${plugin.name}`);
    names.add(plugin.name);
    let pluginUrl;
    try { pluginUrl = new URL(plugin.url); } catch { throw new Error(`Plugin ${plugin.name} needs a valid HTTPS URL.`); }
    if (pluginUrl.protocol !== 'https:' || pluginUrl.username || pluginUrl.password) throw new Error(`Plugin ${plugin.name} must use an HTTPS URL without embedded credentials.`);
    if (plugin.transport !== undefined && !['mcp', 'local'].includes(plugin.transport)) throw new Error(`Plugin ${plugin.name} has an unsupported transport.`);
    if (typeof plugin.tokenEnv !== 'string') throw new Error(`Plugin ${plugin.name} needs a tokenEnv string (empty when unauthenticated).`);
    if (!Array.isArray(plugin.readTools) || !Array.isArray(plugin.writeTools)) throw new Error(`Plugin ${plugin.name} must declare readTools and writeTools arrays.`);
    for (const tool of [...plugin.readTools, ...plugin.writeTools]) {
      if (typeof tool !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(tool)) throw new Error(`Plugin ${plugin.name} contains an invalid tool name.`);
    }
    if (new Set(plugin.readTools).size !== plugin.readTools.length || new Set(plugin.writeTools).size !== plugin.writeTools.length) throw new Error(`Plugin ${plugin.name} has duplicate tool names.`);
    if (plugin.readTools.some((tool) => plugin.writeTools.includes(tool))) throw new Error(`Plugin ${plugin.name} must separate its read and write tools.`);
  }
  return parsed.plugins;
}

export function toAnthropicMcpServer(plugin, env = process.env, legacyConnector = true) {
  if (plugin.transport === 'local') return null;
  const allowedTools = modelAllowedTools(plugin);
  const token = plugin.tokenEnv ? env[plugin.tokenEnv] : undefined;
  if (plugin.tokenEnv && !token) return null;
  const server = {
    type: 'url',
    url: plugin.url,
    name: plugin.name,
  };
  if (legacyConnector) server.tool_configuration = {
      enabled: true,
      allowed_tools: allowedTools,
    };
  if (token) server.authorization_token = token;
  return server;
}

export function availablePlugins(plugins, env = process.env) {
  return plugins.map((plugin) => ({
    name: plugin.name,
    transport: plugin.transport ?? 'mcp',
    configured: !plugin.tokenEnv || Boolean(env[plugin.tokenEnv]),
    readTools: modelAllowedTools(plugin),
    writeTools: plugin.writeTools,
  }));
}
