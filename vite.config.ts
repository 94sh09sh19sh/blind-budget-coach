import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // 建置後的頁面（含示範 CSV）全部預先快取，斷網也能載入並分類
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'samples/*.csv'],
      workbox: { globPatterns: ['**/*.{js,css,html,svg,csv}'] },
      manifest: {
        name: 'Blind Budget Coach',
        short_name: 'BudgetCoach',
        description: 'A budgeting coach that never sees your line items.',
        theme_color: '#1d6a4c',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
      },
    }),
  ],
})
