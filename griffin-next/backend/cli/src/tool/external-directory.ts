import path from "path"
import type { Tool } from "./tool"
import { Instance } from "../project/instance"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  if (!target) return

  if (options?.bypass) return

  if (Instance.containsPath(target)) return

  const kind = options?.kind ?? "file"
  const normalizedTarget = target.replace(/\\/g, "/")
  const parentDir = (kind === "directory" ? normalizedTarget : path.dirname(normalizedTarget)).replace(/\\/g, "/")
  const glob = (parentDir.endsWith("/") ? parentDir + "*" : parentDir + "/*")

  await ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: normalizedTarget,
      parentDir,
    },
  })
}
