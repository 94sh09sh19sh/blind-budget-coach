// 所有模型推論都走 Firebase AI Logic（firebase/ai 的混合推論）。這裡是唯一碰 SDK 的地方。
// 裝置端：getGenerativeModel + InferenceMode.ONLY_ON_DEVICE；雲端：PREFER_IN_CLOUD 或 ONLY_IN_CLOUD。
// SDK 的裝置端路徑每次呼叫都會再建立一個 Chrome session（用 createOptions.initialPrompts 帶系統提示），
// 結構化輸出只能設在模型層級（promptOptions.responseConstraint），所以每種任務各建一個模型物件。
import { getGenerativeModel, InferenceMode, type GenerativeModel } from 'firebase/ai'
import { CLOUD_CONFIGURED, CLOUD_MODEL, getAi } from '../firebase'

export type Gen = (prompt: string) => Promise<string>

export interface DeviceModel {
  generate: Gen
  /** 實際走的是哪一端（SDK 回報），給時間線用 */
  lastSource: () => 'device' | 'cloud' | 'unknown'
}

const EXPECTED = [{ type: 'text' as const, languages: ['en'] }]

/** 必須在使用者手勢內呼叫（可能觸發模型下載）。onProgress 收 0～1。 */
export async function createDeviceModel(opts: {
  system: string
  schema: object
  onProgress?: (p: number) => void
}): Promise<DeviceModel> {
  const model: GenerativeModel = getGenerativeModel(getAi(), {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: {
      createOptions: {
        expectedInputs: EXPECTED,
        expectedOutputs: EXPECTED,
        initialPrompts: [{ role: 'system', content: [{ type: 'text', value: opts.system }] }],
      },
      promptOptions: { responseConstraint: opts.schema },
    },
  })
  await model.initializeDeviceModel(opts.onProgress)
  let last: 'device' | 'cloud' | 'unknown' = 'unknown'
  return {
    async generate(prompt) {
      const r = await model.generateContent(prompt)
      last = r.response.inferenceSource === 'in_cloud' ? 'cloud' : r.response.inferenceSource === 'on_device' ? 'device' : 'unknown'
      return r.response.text()
    },
    lastSource: () => last,
  }
}

export type CloudMode = 'PREFER_IN_CLOUD' | 'ONLY_IN_CLOUD'

export interface CloudRequest {
  mode: CloudMode
  system: string
  prompt: string
  /** 回應的 JSON Schema */
  schema: object
}

export interface CloudResult {
  text: string
  /** 實際在哪一端執行（PREFER_IN_CLOUD 可能退回裝置端） */
  source: 'cloud' | 'device'
}

/** 可注入的雲端呼叫；單元測試用假的，正式版用 firebaseCloudCall。 */
export type CloudCall = (req: CloudRequest) => Promise<CloudResult>

/** 真的雲端呼叫。設定是佔位值時直接丟錯，不送任何請求。 */
export const firebaseCloudCall: CloudCall = async (req) => {
  if (!CLOUD_CONFIGURED) throw new Error('Cloud is not configured (placeholder Firebase config).')
  const mode = req.mode === 'ONLY_IN_CLOUD' ? InferenceMode.ONLY_IN_CLOUD : InferenceMode.PREFER_IN_CLOUD
  const model = getGenerativeModel(getAi(), {
    mode,
    inCloudParams: {
      model: CLOUD_MODEL,
      systemInstruction: req.system,
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: req.schema as { [k: string]: unknown } },
    },
    onDeviceParams: {
      createOptions: {
        expectedInputs: EXPECTED,
        expectedOutputs: EXPECTED,
        initialPrompts: [{ role: 'system', content: [{ type: 'text', value: req.system }] }],
      },
      promptOptions: { responseConstraint: req.schema },
    },
  })
  const r = await model.generateContent(req.prompt)
  return { text: r.response.text(), source: r.response.inferenceSource === 'on_device' ? 'device' : 'cloud' }
}

/** 一次雲端請求會送出的內容位元組數（system + prompt 的 UTF-8 長度，不含 HTTP 標頭與 JSON 外框）。 */
export function requestBytes(system: string, prompt: string): number {
  const enc = new TextEncoder()
  return enc.encode(system).length + enc.encode(prompt).length
}
