import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 相对 base，兼容 GitHub Pages 项目站点任意仓库名路径
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ['echarts'],
          react: ['react', 'react-dom'],
          motion: ['framer-motion'],
        },
      },
    },
  },
})
