// 關鍵字規則式分類：裝置端模型不可用時的備援，完全在本機執行。
// 只放一般字詞，不放任何品牌名稱（賽事規則不得顯示第三方商標）。
import type { Category } from './categories'
import { normalizeDesc } from './normalize'

// 順序有意義：先比對較特定的類別
const RULES: [Category, RegExp][] = [
  ['Delivery', /DELIVERY|COURIER|MEAL ?KIT|TAKEOUT/],
  ['Income', /PAYROLL|DIRECT DEP|INTEREST PAID|TAX REF|SALARY|DIVIDEND/],
  ['Transfers', /TRANSFER|CREDIT CARD PAYMENT|AUTOPAY|WIRE|P2P/],
  ['Housing', /RENT|MORTGAGE|HOA|APARTMENTS|APTS|PROPERTY M|LANDLORD/],
  ['Subscriptions', /STREAM|MUSIC|DIGITAL SUB|SUBSCRIPTION|MEMBERSHIP|STORAGE|CLOUD|SOFTWARE|NEWS/],
  ['Utilities', /WIRELESS|CABLE|WATER|POWER|ELECTRIC|GAS COMPANY|INTERNET|SEWER|BROADBAND|TELECOM|UTILIT/],
  ['Travel', /AIRLINES?|AIR LINES|AIRWAYS|HOTEL|MOTEL|RESORT|LODGE|HOSTEL|CAR RENTAL|BOOKING|VACATION/],
  ['Transport', /TRANSIT|PARKING|TOLL|TAXI|CAB\b|RIDESHARE|FUEL|GAS STATION|RAIL|BUS FARE|METRO/],
  ['Health', /PHARMACY|DRUG ?STORE|DENTAL|DENTIST|CLINIC|LAB\b|OPTOMETRY|OPTICAL|URGENT CARE|DOCTOR|\bDR\b|HOSPITAL|MEDICAL|VISION/],
  ['Entertainment', /THEATRE|THEATER|CINEMA|MOVIE|CONCERT|TICKET|ARCADE|BOWL|ZOO|MUSEUM|GAME|AMUSEMENT/],
  ['Groceries', /GROCER|MARKET|SUPERMARKET|FOODS|FRESH|PRODUCE|BUTCHER/],
  ['Dining', /CAFE|COFFEE|RESTAURANT|PIZZA|DINER|TACO|SUSHI|BISTRO|GRILL|NOODLE|BAKERY|EATERY|KITCHEN|TAVERN|BAR & |BURGER/],
  ['Shopping', /STORE|BOUTIQUE|HARDWARE|OUTLET|SHOP|MALL|APPAREL|FURNITURE|HOME GOODS|ONLINE ORDER/],
]

// 明顯的薪資入帳字樣：裝置端分類在問模型之前就用這條規則判為 Income，不經模型（時間線與介面都標 Rules）。
// 範圍刻意很窄（只看字樣、不看金額正負）；利息、退稅、股利等其他收入仍交給模型。
// 起因：示範資料的 DIRECT DEP BRIGHTWAVE LLC 曾被模型判成 Transfers。
const PAYROLL_DEPOSIT = /\b(?:PAYROLL|DIRECT DEP(?:OSIT)?|SALARY|PAYCHECK)\b/i

export function isPayrollDeposit(desc: string): boolean {
  return PAYROLL_DEPOSIT.test(desc)
}

/** 回傳類別；沒有任何規則命中時回傳 null。 */
export function classifyByRules(desc: string): Category | null {
  const t = normalizeDesc(desc)
  for (const [cat, re] of RULES) if (re.test(t)) return cat
  return null
}
