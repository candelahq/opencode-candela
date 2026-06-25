/**
 * Auto-discover Candela server URL from config files.
 *
 * Resolution order:
 * 1. CANDELA_PROXY_URL env var (explicit override)
 * 2. CANDELA_CONFIG env var → read port from that YAML file
 * 3. ./config.yaml (project-local Candela config)
 * 4. ~/.config/candela/config.yaml (global Candela config)
 * 5. Default: http://localhost:8181
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_URL = "http://localhost:8181";

/**
 * Extract the server port from a Candela config.yaml file.
 * Uses regex to avoid a YAML parser dependency.
 *
 * Looks for the pattern:
 * ```yaml
 * server:
 *   port: 8181
 * ```
 */
function extractPortFromConfig(filePath: string): number | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf-8");

    // Match "server:" section followed by "port: <number>"
    // Handles optional whitespace and comments
    const match = content.match(
      /^server:\s*\n(?:\s+\w+:.*\n)*?\s+port:\s*(\d+)/m,
    );
    if (match?.[1]) {
      return parseInt(match[1], 10);
    }

    // Fallback: simpler pattern for "port:" at any indent under server
    const simpleMatch = content.match(/^\s+port:\s*(\d+)/m);
    if (simpleMatch?.[1]) {
      return parseInt(simpleMatch[1], 10);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the server host from a Candela config.yaml file.
 */
function extractHostFromConfig(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf-8");

    const match = content.match(
      /^server:\s*\n(?:\s+\w+:.*\n)*?\s+host:\s*"?([^"\s\n]+)"?/m,
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Discover the Candela server URL.
 *
 * @returns The best-guess URL for the running Candela instance
 */
export function discoverCandelaUrl(): string {
  // 1. Explicit env var takes priority
  if (process.env.CANDELA_PROXY_URL) {
    return process.env.CANDELA_PROXY_URL;
  }

  // 2. CANDELA_CONFIG env var points to a specific config file
  const configPaths: string[] = [];
  if (process.env.CANDELA_CONFIG) {
    configPaths.push(process.env.CANDELA_CONFIG);
  }

  // 3. Project-local config
  configPaths.push(join(process.cwd(), "config.yaml"));

  // 4. Global config
  configPaths.push(join(homedir(), ".config", "candela", "config.yaml"));

  for (const configPath of configPaths) {
    const port = extractPortFromConfig(configPath);
    if (port) {
      const host = extractHostFromConfig(configPath) ?? "localhost";
      // Normalize 0.0.0.0 to localhost for client connections
      const clientHost = host === "0.0.0.0" ? "localhost" : host;
      return `http://${clientHost}:${port}`;
    }
  }

  // 5. Default
  return DEFAULT_URL;
}
