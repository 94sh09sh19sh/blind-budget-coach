// 自繪圖示（不連外、不用任何品牌標誌）。統一 1.6 線寬、24 格。
import type { ReactNode } from 'react'

function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

export const IconDevice = (p: { size?: number }) => (
  <Svg {...p}><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2.5 19h19" /></Svg>
)
export const IconCloud = (p: { size?: number }) => (
  <Svg {...p}><path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.5 4.25 4.25 0 0 0 7 18Z" /></Svg>
)
export const IconGate = (p: { size?: number }) => (
  <Svg {...p}><path d="M5 12h12" /><path d="m13 8 4 4-4 4" /><path d="M20 5v14" /></Svg>
)
export const IconCheck = (p: { size?: number }) => (
  <Svg {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>
)
export const IconRules = (p: { size?: number }) => (
  <Svg {...p}><path d="M5 7h14M5 12h9M5 17h11" /></Svg>
)
export const IconUpload = (p: { size?: number }) => (
  <Svg {...p}><path d="M12 15V5" /><path d="m8 9 4-4 4 4" /><path d="M5 15v3a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18v-3" /></Svg>
)
export const IconAlert = (p: { size?: number }) => (
  <Svg {...p}><path d="M12 4 2.8 19.5h18.4Z" /><path d="M12 10v4.5" /><path d="M12 17.2v.1" /></Svg>
)

export function Logo() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--device)" />
      <rect x="7" y="9" width="12" height="14" rx="2" fill="none" stroke="var(--on-device)" strokeWidth="2" />
      <path d="M23 9v14" stroke="var(--on-device)" strokeWidth="2" strokeDasharray="2 2.2" strokeLinecap="round" />
      <circle cx="13" cy="16" r="2" fill="var(--on-device)" />
    </svg>
  )
}
