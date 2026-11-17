import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 面板挂在 /panel 下（与 Go 版同路径）；开发期把接口代理到本地服务
export default defineConfig({
  base: '/panel/',
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5174,
    proxy: {
      '/auth': 'http://127.0.0.1:8081',
      '/admin': 'http://127.0.0.1:8081',
      '/datasources': 'http://127.0.0.1:8081',
      '/data': 'http://127.0.0.1:8081',
      '/endpoints': 'http://127.0.0.1:8081',
    },
  },
})
