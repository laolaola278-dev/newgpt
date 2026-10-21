/**
 * Phase 7 — Agent Tools for Local Project Memory (`memory_*`) & Skills (`skill_*`).
 */

import type { ToolDefinition } from './types';
import { defaultMemoryStore, type ProjectMemoryStore } from '../memory/store';
import { defaultSkillStore, type SkillStore } from '../skills/store';

export function createMemoryTools(
  store: ProjectMemoryStore = defaultMemoryStore,
): ToolDefinition[] {
  const rememberTool: ToolDefinition = {
    name: 'memory_remember',
    description:
      'Persist a concise project fact, convention, or decision in local on-device memory',
    risk: 'safe',
    execution: 'local',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Unique topic slug, e.g. "test-runner" or "auth-architecture"',
        },
        fact: {
          type: 'string',
          description: 'Concise factual note stored strictly on device',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional topic tags for fast retrieval',
        },
      },
      required: ['key', 'fact'],
    },
    async execute(args) {
      const entry = await store.remember({
        key: args['key'] as string,
        fact: args['fact'] as string,
        tags: args['tags'] as string[] | undefined,
      });
      return { stored: true, entry };
    },
  };

  const recallTool: ToolDefinition = {
    name: 'memory_recall',
    description:
      'Search local on-device project memory by keyword or tag for the active workspace',
    risk: 'safe',
    execution: 'local',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional keyword filter across keys, facts, and tags',
        },
        tag: {
          type: 'string',
          description: 'Optional exact tag filter',
        },
        limit: {
          type: 'number',
          description: 'Maximum entries to return (default 20)',
        },
      },
    },
    async execute(args) {
      const entries = await store.recall({
        query: args['query'] as string | undefined,
        tag: args['tag'] as string | undefined,
        limit: args['limit'] as number | undefined,
      });
      return { count: entries.length, entries };
    },
  };

  const forgetTool: ToolDefinition = {
    name: 'memory_forget',
    description: 'Delete a stored note from local on-device project memory by key',
    risk: 'safe',
    execution: 'local',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Memory key to delete',
        },
      },
      required: ['key'],
    },
    async execute(args) {
      const removed = await store.forget(args['key'] as string);
      return { removed, key: args['key'] };
    },
  };

  return [rememberTool, recallTool, forgetTool];
}

export function createSkillTools(
  store: SkillStore = defaultSkillStore,
): ToolDefinition[] {
  const listSkillsTool: ToolDefinition = {
    name: 'skill_list',
    description: 'List available reusable local coding skills and playbooks',
    risk: 'safe',
    execution: 'local',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute() {
      const skills = await store.list();
      return {
        skills: skills.map(({ id, name, description, source }) => ({
          id,
          name,
          description,
          source,
        })),
      };
    },
  };

  const activateSkillTool: ToolDefinition = {
    name: 'skill_activate',
    description: 'Load full step-by-step instructions for a local skill by id',
    risk: 'safe',
    execution: 'local',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Skill identifier, e.g. "code-review", "bug-hunt", or "commit-craft"',
        },
      },
      required: ['id'],
    },
    async execute(args) {
      const skill = await store.get(args['id'] as string);
      if (!skill) {
        throw new Error(`unknown skill "${String(args['id'])}"`);
      }
      return skill;
    },
  };

  return [listSkillsTool, activateSkillTool];
}

export const memoryTools = createMemoryTools();
export const skillTools = createSkillTools();
