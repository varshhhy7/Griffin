import { createHash } from "crypto"

export namespace Hash {
  /**
   * Sort object keys recursively for strict canonical JSON serialization.
   */
  export function canonicalize(obj: any): any {
    if (obj === null || typeof obj !== "object") {
      return obj
    }
    if (Array.isArray(obj)) {
      return obj.map(canonicalize)
    }
    const sortedKeys = Object.keys(obj).sort()
    const result: Record<string, any> = {}
    for (const key of sortedKeys) {
      result[key] = canonicalize(obj[key])
    }
    return result
  }

  /**
   * Computes contentIdV2: sha256(recursiveCanonicalJson).slice(0, 16)
   */
  export function contentIdV2(payload: any): { hash: string; algo: "sha256-16-json-v2" } {
    const canonical = JSON.stringify(canonicalize(payload))
    const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16)
    return { hash, algo: "sha256-16-json-v2" }
  }

  /**
   * Compute sha256 hex string over string or Uint8Array.
   */
  export function sha256Hex(data: string | Uint8Array): string {
    return createHash("sha256").update(data).digest("hex")
  }
}
