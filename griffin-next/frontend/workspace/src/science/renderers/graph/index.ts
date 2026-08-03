import type { ArtifactKind, ArtifactRenderer } from "../registry"
import { LineageGraph } from "./LineageGraph"

export interface RendererRegistration {
  kind: ArtifactKind
  component: ArtifactRenderer
}

export const registrations: RendererRegistration[] = [
  { kind: "graph-lineage" as ArtifactKind, component: LineageGraph as any },
  { kind: "lineage-graph" as ArtifactKind, component: LineageGraph as any },
]

export function registerAll(register: (kind: ArtifactKind, component: ArtifactRenderer) => void): void {
  for (const r of registrations) {
    register(r.kind, r.component)
  }
}
