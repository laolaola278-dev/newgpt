import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// GPT++ — ChatGPT Web Agent Enhancement Extension.
// Phase 0: minimal loadable extension (content script on chatgpt.com,
// side panel, options page). Agent Runtime lands in later phases.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'GPT++',
    description:
      'Give ChatGPT Web a local Coding Agent body: filesystem, shell, git.',
    permissions: ['storage', 'tabs', 'sidePanel', 'nativeMessaging'],
    host_permissions: ['https://chatgpt.com/*'],
    action: { default_title: 'Open GPT++ panel' },
    icons: {
      16: '/icons/gptpp-16.png',
      32: '/icons/gptpp-32.png',
      48: '/icons/gptpp-48.png',
      128: '/icons/gptpp-128.png',
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
