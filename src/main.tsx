import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'

// 註冊 service worker：預先快取整個建置結果，讓離線也能開
registerSW({ immediate: true })

const root = createRoot(document.getElementById('root')!)
if (import.meta.env.DEV && new URLSearchParams(location.search).get('eval') === '1') {
  // 開發用評測入口：動態載入，不影響首頁，正式建置整段剔除
  import('./dev/EvalPage').then(({ default: EvalPage }) => root.render(<EvalPage />))
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
