import type { ProjectFileEntry, ProjectTarget, ProjectTargetEntry } from '../../dsl/types'

export interface ProjectFileSnapshot {
  configHash: string
  file: ProjectFileEntry
  fileIndex: number
  targets: readonly ProjectTargetSnapshot[]
}

export interface ProjectIndex {
  hash: string
  target: ProjectTarget
}

export interface ProjectTargetSnapshot {
  descriptor: ProjectTargetEntry
  semanticHash: string
}
