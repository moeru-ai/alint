export interface CreatePublisherOptions {
  flushMs: number
  /** Sends one document. The caller looks up its diagnostics; this module decides when. */
  publish: (uri: string) => void
}

export interface Publisher {
  dispose: () => void
  isOpen: (uri: string) => boolean
  queue: (uri: string) => void
  setOpen: (uri: string, open: boolean) => void
}

/**
 * Collects document URIs and publishes each one once per window, open documents first.
 *
 * An LSP publish carries a whole document, so one publish per finding would send the same document
 * many times. A workspace pass can queue thousands of documents, and the open one must not wait
 * for the rest.
 */
export function createPublisher(options: CreatePublisherOptions): Publisher {
  // `TextDocuments` from `vscode-languageserver` also tracks open documents, but it keeps the text
  // of each one and needs `vscode-languageserver-textdocument` to build them. This server never
  // reads file content, and it declares `change: None`, so a set of URIs is the whole requirement.
  const open = new Set<string>()
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    timer = undefined

    const uris = [...pending]
    pending.clear()

    for (const uri of uris.filter(uri => open.has(uri))) {
      options.publish(uri)
    }

    for (const uri of uris.filter(uri => !open.has(uri))) {
      options.publish(uri)
    }
  }

  return {
    dispose: () => {
      // A timer that fires after shutdown writes to a closed connection.
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }

      pending.clear()
    },
    isOpen: uri => open.has(uri),
    queue: (uri) => {
      pending.add(uri)
      timer ??= setTimeout(flush, options.flushMs)
    },
    setOpen: (uri, isOpen) => {
      if (isOpen) {
        open.add(uri)
        return
      }

      open.delete(uri)
    },
  }
}
