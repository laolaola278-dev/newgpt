import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { CHATGPT_MATCH_PATTERNS } from './lib/chatgpt-detect';

// GPT++ — ChatGPT Web Agent Enhancement Extension.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'GPT++',
    description:
      'Give ChatGPT Web a local Coding Agent body: filesystem, shell, git.',
    permissions: ['storage', 'tabs', 'sidePanel', 'nativeMessaging'],
    host_permissions: CHATGPT_MATCH_PATTERNS,
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
