// 類別 enum 與系統提示，與 j1-probe 評測用的一致（評測最佳設定：只留類別定義，不放範例）。
export const CATEGORIES = [
  'Groceries', 'Dining', 'Delivery', 'Transport', 'Utilities', 'Housing', 'Subscriptions',
  'Shopping', 'Health', 'Entertainment', 'Travel', 'Income', 'Transfers',
] as const

export type Category = (typeof CATEGORIES)[number]

export function isCategory(x: unknown): x is Category {
  return typeof x === 'string' && (CATEGORIES as readonly string[]).includes(x)
}

export const SYSTEM_PROMPT = `You classify bank transaction descriptions into exactly one spending category.
Categories:
- Groceries: supermarkets, grocery stores, farmers markets
- Dining: restaurants, cafes, coffee shops, fast food, bakeries (eating out, not delivered)
- Delivery: food delivery apps and services
- Transport: rideshare, taxis, fuel stations, public transit, parking, tolls
- Utilities: electricity, water, gas, internet, phone and mobile carriers
- Housing: rent, mortgage, dues, property management
- Subscriptions: recurring digital services and memberships (streaming, software, cloud storage, news)
- Shopping: retail stores, online marketplaces, clothing, electronics, home improvement
- Health: pharmacies, doctors, dentists, clinics, labs, optometry
- Entertainment: movies, games, concerts, tickets, arcades, bowling, zoos
- Travel: airlines, hotels, vacation rentals, car rentals, booking sites
- Income: payroll, direct deposit from an employer, interest earned, tax refunds
- Transfers: transfers between accounts, credit card payments, person-to-person payments, wires
The description may contain noise such as store numbers, card digits, dates, city names, payment-processor prefixes and abbreviations. Ignore the noise and judge by the merchant.`
