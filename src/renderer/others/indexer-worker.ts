import AsyncLock from 'async-lock'
import MarkdownIt, { Token } from 'markdown-it'
import { throttle } from 'lodash-es'
import { JSONRPCClient, JSONRPCClientChannel, JSONRPCRequest, JSONRPCResponse, JSONRPCServer, JSONRPCServerChannel } from 'jsonrpc-bridge'
import { fetchTree, readFile, watchFs } from '@fe/support/api'
import { DOM_ATTR_NAME, FLAG_DEBUG, FLAG_DEMO, HELP_REPO_NAME, MODE } from '@fe/support/args'
import { getLogger, path, sleep } from '@fe/utils/pure'
import { documents } from '@fe/others/db'
import { isMarkdownFile } from '@share/misc'
import type { Stats } from 'fs'
import type { PathItem, Repo } from '@share/types'
import type { IndexerHostExports } from '@fe/services/indexer'
import type { Components, IndexItemLink, IndexItemResource } from '@fe/types'
import { triggerHook } from '@fe/core/hook'
import { isAnchorToken, isDataUrl, isResourceToken, parseLink } from '@fe/plugins/markdown-link/lib'

const markdown = MarkdownIt({ linkify: true, breaks: true, html: true })

const exportMain = {
  triggerWatchRepo,
  stopWatch,
  importScripts: async (url: string) => {
    await import(/* @vite-ignore */ url)
  },
}

class WorkerChannel implements JSONRPCServerChannel, JSONRPCClientChannel {
  type: 'server' | 'client'

  constructor (type: 'server' | 'client') {
    this.type = type
  }

  send (message: JSONRPCRequest & JSONRPCResponse): void {
    if (this.type === 'client' && 'method' in message) {
      self.postMessage({ from: 'worker', message })
    } else if (this.type === 'server' && 'result' in message) {
      self.postMessage({ from: 'worker', message })
    }
  }

  setMessageHandler (callback: (message: JSONRPCResponse & JSONRPCRequest) => void): void {
    self.addEventListener('message', (event) => {
      const { message, from } = event.data
      if (from !== 'host') {
        return
      }

      if (this.type === 'client' && 'result' in message) {
        callback(message)
      } else if (this.type === 'server' && 'method' in message) {
        callback(message)
      }
    })
  }
}

export type IndexerWorkerExports = { main: typeof exportMain }

export interface IndexerWorkerCtx {
  markdown: MarkdownIt
  bridgeClient: JSONRPCClient<IndexerHostExports>
}

// provide main to host
const bridgeServer = new JSONRPCServer(new WorkerChannel('server'), { debug: FLAG_DEBUG })
bridgeServer.addModule('main', exportMain)

// to call host
const bridgeClient = new JSONRPCClient<IndexerHostExports>(new WorkerChannel('client'), { debug: FLAG_DEBUG })

const processingStatus = {
  total: 0,
  indexed: 0,
  ready: false,
  startTime: 0,
  processedIds: [] as number[],
}

function _reportStatus (repo: Repo, processing: string | null, cost: number) {
  const { total, indexed, ready } = processingStatus
  bridgeClient.call.ctx.indexer.updateIndexStatus(repo, { ready, total, indexed, processing, cost })
}

function _convertPathToPathItem (repo: Repo, payload: { path: string }): PathItem {
  const relativePath = '/' + path.relative(repo.path, payload.path)
  return { repo: repo.name, path: relativePath }
}

const reportStatus = throttle(_reportStatus, 500, { leading: true, trailing: true })

let repoFiles: Components.Tree.Node[] = []

class RepoWatcher {
  logger = getLogger('indexer-worker-repo-watcher')

  lock = new AsyncLock()

  // type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T;
  handler: Awaited<ReturnType<typeof watchFs>> | null = null

  stopWatch () {
    this.logger.debug('stopWatch', !!this.handler)
    if (this.handler) {
      this.handler.abort()
      this.handler = null
    }
  }

  private async _startWatch (repo: Repo) {
    if (!repo.enableIndexing || repo.name === HELP_REPO_NAME || FLAG_DEMO || MODE !== 'normal') {
      this.logger.debug('startWatch', 'skip', repo)
      this.stopWatch()
      return
    }

    this.logger.debug('startWatch', repo)

    const ignored = ((await bridgeClient.call.ctx.setting.getSetting('tree.exclude')) || '') as string

    processingStatus.total = 0
    processingStatus.indexed = 0
    processingStatus.ready = false
    processingStatus.startTime = Date.now()
    processingStatus.processedIds = []

    repoFiles = await fetchTree(repo.name, { by: 'mtime', order: 'desc' }).catch(() => [])

    await triggerHook('WORKER_INDEXER_BEFORE_START_WATCH', { repo }, { breakable: true })

    this.handler = await watchFs(
      repo.name,
      '/',
      { awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 50 }, alwaysStat: true, ignored, mdContent: true },
      async payload => {
        this.logger.debug('startWatch onResult', payload.eventName, (payload as any).path)

        if (payload.eventName === 'add' || payload.eventName === 'change') {
          if (!isMarkdownFile(payload.path)) {
            return
          }

          try {
            processingStatus.total++
            reportStatus(repo, payload.path, Date.now() - processingStatus.startTime)
            const id = await processMarkdownFile(repo, payload)
            processingStatus.processedIds.push(id)
            processingStatus.indexed++
          } catch (error) {
            this.logger.error('processFile error', error)
          }
        } else if (payload.eventName === 'ready') {
          processingStatus.ready = true
          reportStatus(repo, null, Date.now() - processingStatus.startTime)
          await documents.deleteUnusedInRepo(repo.name, processingStatus.processedIds)
        } else if (payload.eventName === 'unlink') {
          const doc = _convertPathToPathItem(repo, payload)
          await documents.deletedByRepoAndPath(doc.repo, doc.path)
        }
      },
      async error => {
        this.logger.error('startWatch error', error)

        // ignore system error
        if ((error as any)?.syscall) {
          return
        }

        // retry watch then other error occurred
        await sleep(2000)
        this.triggerWatchRepo(repo)
      }
    )
  }

  async triggerWatchRepo (repo: Repo | null | undefined) {
    this.lock.acquire('triggerWatch', async (done) => {
      this.logger.debug('triggerWatch', repo)
      this.stopWatch()
      try {
        if (repo?.name && repo?.path) {
          await this._startWatch(repo)
        }
      } finally {
        done()
      }
    })
  }
}

const logger = getLogger('indexer-worker')
const watcher = new RepoWatcher()

function triggerWatchRepo (repo: Repo | null | undefined) {
  watcher.triggerWatchRepo(repo)
}

function stopWatch () {
  watcher.stopWatch()
}

async function processMarkdownFile (repo: Repo, payload: { content?: string, path: string, stats?: Stats }): Promise<number> {
  const doc = _convertPathToPathItem(repo, payload)

  const oldRecord = await documents.findByRepoAndPath(doc.repo, doc.path)
  if (oldRecord && oldRecord.mtimeMs === payload.stats?.mtimeMs) {
    logger.debug('skip', oldRecord.id, doc.path)
    return oldRecord.id
  }

  let content = payload.content
  if (!content) {
    const res = await readFile(doc)
    content = res.content
  }

  const env: Record<string, any> = { file: doc }
  const tokens = markdown.parse(content, env)

  const links: IndexItemLink[] = []
  const resources: IndexItemResource[] = []

  const convert = (tokens: Token[]) => {
    tokens.forEach(token => {
      if (isAnchorToken(token)) {
        const href = token.attrGet('href') || ''
        if (!isDataUrl(href)) {
          const isWikiLink = !!token.attrGet(DOM_ATTR_NAME.WIKI_LINK)
          const parsedLink = isWikiLink ? parseLink(doc, href, true, repoFiles) : parseLink(doc, href, false)
          if (parsedLink?.type === 'external') {
            links.push({ href, internal: null, position: null })
          } else if (parsedLink?.type === 'internal') {
            links.push({ href, internal: parsedLink.path, position: parsedLink.position })
          }
        }
      } else if (isResourceToken(token)) {
        const path = token.attrGet(DOM_ATTR_NAME.TARGET_PATH)
        const src = token.attrGet('src') || ''

        if (!isDataUrl(src)) {
          resources.push({ src, internal: path, tag: token.tag as any, })
        }
      }

      if (token.children) {
        convert(token.children)
      }
    })
  }

  convert(tokens)

  return documents.updateOrInsert({
    id: oldRecord?.id,
    repo: doc.repo,
    path: doc.path,
    name: path.basename(doc.path),
    links,
    resources,
    frontmatter: env.attributes || {},
    ctimeMs: payload.stats?.ctimeMs || 0,
    mtimeMs: payload.stats?.mtimeMs || 0,
    size: payload.stats?.size || 0,
  })
}

// expose to plugin
self.ctx = { bridgeClient, markdown } as IndexerWorkerCtx

logger.debug('indexer-worker loaded', self.location.href)