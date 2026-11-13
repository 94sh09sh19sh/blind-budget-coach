import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { buildCsp } from './src/csp.ts'
import { cspPlugin } from './vite-plugin-csp.ts'

// https://vite.dev/config/
export default defineConfig({
  // vite preview 沒有 Firebase Hosting 的標頭，這裡補同一份，讓本機預覽的建置版同時受標頭版與 meta 版政策約束（與上線一致）
  preview: { headers: { 'Content-Security-Policy': buildCsp('header') } },
  plugins: [
    react(),
    // 正式建置時注入 CSP meta（開發伺服器不注入）；政策內容在 src/csp.ts
    cspPlugin(),
    // 建置後的頁面（含示範 CSV）全部預先快取，斷網也能載入並分類
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png', 'samples/*.csv'],
      workbox: { globPatterns: ['**/*.{js,css,html,svg,csv,png}'] },
      manifest: {
        name: 'Blind Budget Coach',
        short_name: 'BudgetCoach',
        description: 'A budgeting coach that classifies your bank statement in the browser on this device. You can check what leaves it.',
        theme_color: '#1d6a4c',
        background_color: '#ffffff',
        display: 'standalone',
        // 一般版與 maskable 版各 192／512；maskable 版背景滿版、圖形縮在安全區內（都由自繪的 favicon.svg 算出，沒有第三方圖形）
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
    }),
  ],
})
