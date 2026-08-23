/**
 * Minimal tool registry. Lookup + registration only — routing lives in the
 * runtime executor, orchestration in the loop controller.
 */

import type { ToolDefinition } from './types';
import { demoEchoTool } from './demo-echo';
import { nativeEchoTool } from './native-echo';

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    if (this.tools.has(def.name)) {
      throw new Error(`tool "${def.name}" is already registered`);
    }
    this.tools.set(def.name, def);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Array<Pick<ToolDefinition, 'name' | 'description' | 'risk'>> {
    return [...this.tools.values()].map(({ name, description, risk }) => ({
      name,
      description,
      risk,
    }));
  }
}

/** Registry instance shared by the background service worker. */
export const defaultRegistry = new ToolRegistry();
defaultRegistry.register(demoEchoTool);
defaultRegistry.register(nativeEchoTool);
