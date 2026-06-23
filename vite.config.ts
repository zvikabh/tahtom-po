import { defineConfig } from 'vite';

export default defineConfig({
  // Firebase Hosting serves the contents of dist/ at the site root.
  build: {
    outDir: 'dist',
    target: 'es2021',
  },
});
